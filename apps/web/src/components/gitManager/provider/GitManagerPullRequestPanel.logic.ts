import type {
  GitActionProgressEvent,
  GitActionProgressPhase,
  GitManagerCommitEntry,
  GitManagerPullRequestsResult,
  GitRunStackedActionResult,
  SourceControlProviderInfo,
  VcsStatusResult,
} from "@bibcode/contracts";

export type ProviderPanePresentation =
  | { readonly kind: "not-loaded"; readonly message: string }
  | { readonly kind: "loading"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "loaded"; readonly message: string };

export function resolveProviderPanePresentation(input: {
  readonly requested: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly result: GitManagerPullRequestsResult | null;
}): ProviderPanePresentation {
  if (!input.requested) {
    return {
      kind: "not-loaded",
      message: "Pull requests and checks load only when you choose Refresh.",
    };
  }
  if (input.pending) {
    return { kind: "loading", message: "Loading pull requests and checks…" };
  }
  if (input.error !== null) {
    return { kind: "error", message: input.error };
  }
  if (input.result?.status === "unavailable") {
    return {
      kind: "unavailable",
      message: "Pull requests or checks are unavailable for this repository provider.",
    };
  }
  return {
    kind: "loaded",
    message:
      input.result?.pullRequests.length === 0
        ? "No open pull request was found for the current branch."
        : "Pull requests and checks loaded.",
  };
}

export interface ReviewedPullRequest {
  readonly title: string;
  readonly body: string;
}

/**
 * The stacked `create_pr` action carrying the reviewed title and body. The body
 * is sent only when the user wrote one so the server keeps its empty default.
 */
export function createPullRequestAction(actionId: string, reviewed?: ReviewedPullRequest) {
  const title = reviewed?.title.trim() ?? "";
  const body = reviewed?.body ?? "";
  return {
    actionId,
    action: "create_pr" as const,
    ...(title.length > 0 ? { pullRequestTitle: title } : {}),
    ...(body.trim().length > 0 ? { pullRequestBody: body } : {}),
  };
}

export interface ExistingPullRequestSummary {
  readonly number: number;
  readonly title: string;
  readonly url: string;
}

/**
 * Everything the review surface shows before anything is published: where the
 * pull request goes, which branches it joins, whether the branch must be
 * published first, and why the action is unavailable when it is.
 */
export interface CreatePullRequestReview {
  readonly provider: SourceControlProviderInfo | null;
  readonly head: string | null;
  readonly base: string;
  readonly publishRequired: boolean;
  readonly existingPullRequest: ExistingPullRequestSummary | null;
  readonly defaultTitle: string;
  readonly defaultBody: string;
  readonly blockedReason: string | null;
}

export function resolveCreatePullRequestReview(input: {
  readonly status: VcsStatusResult;
  readonly latestCommit: GitManagerCommitEntry | null;
}): CreatePullRequestReview {
  const { status, latestCommit } = input;
  const provider = status.sourceControlProvider ?? null;
  const head = status.refName;
  const base = status.defaultRefName ?? "main";
  const existingPullRequest =
    status.pr === null
      ? null
      : { number: status.pr.number, title: status.pr.title, url: status.pr.url };
  const blockedReason = !status.isRepo
    ? "This folder is not a Git repository."
    : head === null
      ? "Check out a branch before creating a pull request."
      : provider === null
        ? "No supported source-control provider was found for this repository's remote."
        : status.hasWorkingTreeChanges
          ? "Commit local changes before creating a pull request."
          : null;
  const defaultTitle = latestCommit?.subject.trim() ?? "";
  return {
    provider,
    head,
    base,
    publishRequired: !status.hasUpstream || status.aheadCount > 0,
    existingPullRequest,
    defaultTitle: defaultTitle.length > 0 ? defaultTitle : head === null ? "" : `Update ${head}`,
    defaultBody: latestCommit?.body.trim() ?? "",
    blockedReason,
  };
}

export type CreatePullRequestProgress =
  | { readonly kind: "review" }
  | {
      readonly kind: "running";
      readonly phase: GitActionProgressPhase | null;
      readonly pushed: boolean;
    }
  | {
      readonly kind: "failed";
      readonly phase: GitActionProgressPhase | null;
      readonly message: string;
      /** The branch was published in this attempt before the failure. */
      readonly branchPublished: boolean;
    }
  | { readonly kind: "created"; readonly url: string | null; readonly number: number | null }
  | { readonly kind: "existing"; readonly url: string | null; readonly number: number | null };

export const REVIEW_PROGRESS: CreatePullRequestProgress = { kind: "review" };

function pullRequestOutcome(result: GitRunStackedActionResult): CreatePullRequestProgress {
  const kind = result.pr.status === "opened_existing" ? "existing" : "created";
  return { kind, url: result.pr.url ?? null, number: result.pr.number ?? null };
}

/** Folds server progress events into the dialog's progress state. */
export function reduceCreatePullRequestProgress(
  state: CreatePullRequestProgress,
  event: GitActionProgressEvent,
): CreatePullRequestProgress {
  const pushed = state.kind === "running" && (state.pushed || state.phase === "push");
  switch (event.kind) {
    case "action_started":
      return { kind: "running", phase: null, pushed: false };
    case "phase_started":
      return { kind: "running", phase: event.phase, pushed };
    case "action_finished":
      return pullRequestOutcome(event.result);
    case "action_failed":
      return {
        kind: "failed",
        phase: event.phase,
        message: event.message,
        branchPublished: pushed && event.phase === "pr",
      };
    case "hook_started":
    case "hook_output":
    case "hook_finished":
      return state.kind === "running" ? state : { kind: "running", phase: null, pushed };
  }
}

/** The failure state when the action settled without an `action_failed` event. */
export function failCreatePullRequestProgress(
  state: CreatePullRequestProgress,
  message: string,
): CreatePullRequestProgress {
  // A settled outcome or the server's own `action_failed` report is authoritative.
  if (state.kind === "created" || state.kind === "existing" || state.kind === "failed") {
    return state;
  }
  const phase = state.kind === "running" ? state.phase : null;
  const pushed = state.kind === "running" && (state.pushed || state.phase === "push");
  return {
    kind: "failed",
    phase,
    message,
    branchPublished: pushed && phase === "pr",
  };
}

export interface CreatePullRequestProgressPresentation {
  readonly status: string | null;
  readonly tone: "neutral" | "error" | "success";
  readonly primaryLabel: string;
  readonly busy: boolean;
  readonly settled: boolean;
}

export function presentCreatePullRequestProgress(
  state: CreatePullRequestProgress,
  review: Pick<CreatePullRequestReview, "publishRequired" | "head">,
): CreatePullRequestProgressPresentation {
  switch (state.kind) {
    case "review":
      return {
        status: null,
        tone: "neutral",
        primaryLabel: review.publishRequired
          ? "Publish and create pull request"
          : "Create pull request",
        busy: false,
        settled: false,
      };
    case "running":
      return {
        status:
          state.phase === "push"
            ? `Publishing ${review.head ?? "the branch"}…`
            : state.phase === "pr"
              ? "Creating the pull request…"
              : "Starting…",
        tone: "neutral",
        primaryLabel: "Working…",
        busy: true,
        settled: false,
      };
    case "failed":
      return {
        status:
          state.phase === "push"
            ? `Publishing ${review.head ?? "the branch"} failed: ${state.message}`
            : state.branchPublished
              ? `${review.head ?? "The branch"} was published, but creating the pull request failed: ${state.message}`
              : `Creating the pull request failed: ${state.message}`,
        tone: "error",
        primaryLabel: "Retry",
        busy: false,
        settled: false,
      };
    case "created":
      return {
        status:
          state.number === null
            ? "Pull request created."
            : `Pull request #${String(state.number)} created.`,
        tone: "success",
        primaryLabel: "Done",
        busy: false,
        settled: true,
      };
    case "existing":
      return {
        status:
          state.number === null
            ? "A pull request already exists for this branch, so none was created."
            : `Pull request #${String(state.number)} already exists for this branch, so none was created.`,
        tone: "success",
        primaryLabel: "Done",
        busy: false,
        settled: true,
      };
  }
}
