import type {
  PipelinesAction,
  PipelinesActionResult,
  PipelinesActionTarget,
  PullRequestsContext,
  PullRequestsPipelineStatus,
  PullRequestsProviderKind,
} from "@bibcode/contracts";

/** One action on one pipeline or job. */
export interface PipelineActionRequest {
  readonly target: PipelinesActionTarget;
  readonly action: PipelinesAction;
}

export function pipelineActionKey(request: PipelineActionRequest): string {
  return `${request.target._tag}:${request.target.id}:${request.action}`;
}

/** Where a view goes once an action answered; `null` stays and re-reads. */
export type PipelineActionDestination =
  | { readonly kind: "job"; readonly pipelineId: number; readonly jobId: number }
  | { readonly kind: "pipeline"; readonly pipelineId: number };

/**
 * A GitLab job retry is a new job: its page opens. A GitHub re-run is the run's next
 * attempt: a page showing an earlier attempt, or a job (whose id the next attempt
 * replaces), opens the run's latest attempt. Anything else stays where it is.
 */
export function pipelineActionDestination({
  provider,
  request,
  result,
  shown,
}: {
  provider: PullRequestsProviderKind;
  request: PipelineActionRequest;
  result: PipelinesActionResult;
  /** The page's pipeline, its earlier attempt (`null` on the latest) and its job, if any. */
  shown: {
    readonly pipelineId: number;
    readonly attempt: number | null;
    readonly jobId: number | null;
  };
}): PipelineActionDestination | null {
  const retried = request.action === "retry" || request.action === "retry_failed";
  if (!retried) return null;
  if (provider === "gitlab") {
    if (request.target._tag !== "job" || result.jobId === null) return null;
    if (result.jobId === request.target.id) return null;
    return {
      kind: "job",
      pipelineId: result.pipelineId ?? shown.pipelineId,
      jobId: result.jobId,
    };
  }
  const pipelineId = result.pipelineId ?? shown.pipelineId;
  if (shown.attempt !== null || shown.jobId !== null || pipelineId !== shown.pipelineId)
    return { kind: "pipeline", pipelineId };
  return null;
}

/** What an action's failure says; the server writes the host's copy. */
export function pipelineActionError(cause: unknown): string {
  if (
    cause !== null &&
    typeof cause === "object" &&
    "message" in cause &&
    typeof cause.message === "string" &&
    cause.message.trim().length > 0
  )
    return cause.message;
  return "The action failed. Refresh and try again.";
}

export function pipelineActionHostDetail(cause: unknown): string | null {
  return cause !== null &&
    typeof cause === "object" &&
    "hostDetail" in cause &&
    typeof cause.hostDetail === "string"
    ? cause.hostDetail
    : null;
}

/**
 * GitHub cancels a run in the background (202): until the run's own status moves on,
 * it shows as canceling rather than still running.
 */
export function shownPipelineStatus(
  row: {
    readonly id: number;
    readonly status: PullRequestsPipelineStatus;
    readonly terminal: boolean;
  },
  canceling: ReadonlyMap<number, PullRequestsPipelineStatus>,
): PullRequestsPipelineStatus {
  const before = canceling.get(row.id);
  return before !== undefined && !row.terminal && row.status === before ? "canceling" : row.status;
}

export type RepositoryPermission = Extract<
  PullRequestsContext,
  { readonly repositoryPermission: unknown }
>["repositoryPermission"];

/** GitHub's refusal of an action, remembered by the server for this sign-in. */
export const GITHUB_ACTIONS_REFUSED =
  "GitHub refused: this sign-in can't run Actions for this repository. A fine-grained token needs Actions write.";

/**
 * Whether a GitHub `denied` is GitHub's own refusal rather than the repository role:
 * GitHub grants nothing below write, so a denial with write or higher is a refusal the
 * server remembered.
 */
export function githubRefused(permission: RepositoryPermission | null | undefined): boolean {
  return permission === "write" || permission === "maintain" || permission === "admin";
}
