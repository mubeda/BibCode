import type {
  GitActionProgressEvent,
  GitActionProgressPhase,
  GitManagerCommitEntry,
  GitManagerPullRequestsResult,
  GitRunStackedActionResult,
  PullRequestsProviderKind,
  SourceControlProviderInfo,
  SourceControlProviderKind,
  VcsStatusResult,
} from "@bibcode/contracts";
import {
  formatChangeRequestNumber,
  getChangeRequestTerminology,
  resolveChangeRequestPresentationForKind,
} from "@bibcode/shared/sourceControl";
import { capitalize } from "effect/String";

export type ProviderPanePresentation =
  | { readonly kind: "not-loaded"; readonly message: string }
  | { readonly kind: "loading"; readonly message: string }
  | { readonly kind: "error"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string }
  | { readonly kind: "loaded"; readonly message: string };

export function resolveProviderPanePresentation(input: {
  readonly providerKind: SourceControlProviderKind | null;
  readonly requested: boolean;
  readonly pending: boolean;
  readonly error: string | null;
  readonly result: GitManagerPullRequestsResult | null;
}): ProviderPanePresentation {
  const changeRequest = resolveChangeRequestPresentationForKind(input.providerKind ?? "github");
  const pluralTitle = capitalize(changeRequest.pluralLongName);
  if (!input.requested) {
    return {
      kind: "not-loaded",
      message: `${pluralTitle} and checks load only when you choose Refresh.`,
    };
  }
  if (input.pending) {
    return { kind: "loading", message: `Loading ${changeRequest.pluralLongName} and checks…` };
  }
  if (input.error !== null) {
    return { kind: "error", message: input.error };
  }
  if (input.result?.status === "unavailable") {
    return {
      kind: "unavailable",
      message: `${pluralTitle} or checks are unavailable for this repository provider.`,
    };
  }
  return {
    kind: "loaded",
    message:
      input.result?.pullRequests.length === 0
        ? `No open ${changeRequest.longName} was found for the current branch.`
        : `${pluralTitle} and checks loaded.`,
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

/** A host the caller already identified: the Pull Requests panel's context. */
export interface CreatePullRequestProviderHint {
  readonly kind: PullRequestsProviderKind;
  readonly host: string;
}

/** The hinted host as a provider, the way status names a GitHub or GitLab host. */
export function hintedProvider(
  hint: CreatePullRequestProviderHint | null,
): SourceControlProviderInfo | null {
  return hint === null
    ? null
    : {
        kind: hint.kind,
        name: resolveChangeRequestPresentationForKind(hint.kind).providerName,
        baseUrl: `https://${hint.host}`,
      };
}

export const UNIDENTIFIED_HOST_REASON =
  "BiBCode hasn't identified this repository's host yet. Open Pull Requests for this project or run Rescan in Settings → Source Control.";

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
  readonly providerHint?: CreatePullRequestProviderHint | null;
}): CreatePullRequestReview {
  const { status, latestCommit } = input;
  // A cold or stale status may not name a host the caller already identified; the
  // hint stands in for it, and the server validates the provider when creating.
  const provider = status.sourceControlProvider ?? hintedProvider(input.providerHint ?? null);
  const noun = getChangeRequestTerminology(provider).singular;
  const head = status.refName;
  const base = status.defaultRefName ?? "main";
  const existingPullRequest =
    status.pr === null
      ? null
      : { number: status.pr.number, title: status.pr.title, url: status.pr.url };
  const blockedReason = !status.isRepo
    ? "This folder is not a Git repository."
    : head === null
      ? `Check out a branch before creating a ${noun}.`
      : provider === null
        ? status.hasPrimaryRemote
          ? UNIDENTIFIED_HOST_REASON
          : `Add an origin remote to create a ${noun}.`
        : status.hasWorkingTreeChanges
          ? `Commit local changes before creating a ${noun}.`
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
  review: Pick<CreatePullRequestReview, "publishRequired" | "head" | "provider">,
): CreatePullRequestProgressPresentation {
  const kind = review.provider?.kind ?? null;
  const noun = getChangeRequestTerminology(review.provider).singular;
  switch (state.kind) {
    case "review":
      return {
        status: null,
        tone: "neutral",
        primaryLabel: review.publishRequired ? `Publish and create ${noun}` : `Create ${noun}`,
        busy: false,
        settled: false,
      };
    case "running":
      return {
        status:
          state.phase === "push"
            ? `Publishing ${review.head ?? "the branch"}…`
            : state.phase === "pr"
              ? `Creating the ${noun}…`
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
              ? `${review.head ?? "The branch"} was published, but creating the ${noun} failed: ${state.message}`
              : `Creating the ${noun} failed: ${state.message}`,
        tone: "error",
        primaryLabel: "Retry",
        busy: false,
        settled: false,
      };
    case "created":
      return {
        status:
          state.number === null
            ? `${capitalize(noun)} created.`
            : `${capitalize(noun)} ${formatChangeRequestNumber(kind, state.number)} created.`,
        tone: "success",
        primaryLabel: "Done",
        busy: false,
        settled: true,
      };
    case "existing":
      return {
        status:
          state.number === null
            ? `A ${noun} already exists for this branch, so none was created.`
            : `${capitalize(noun)} ${formatChangeRequestNumber(kind, state.number)} already exists for this branch, so none was created.`,
        tone: "success",
        primaryLabel: "Done",
        busy: false,
        settled: true,
      };
  }
}
