import type {
  GitActionProgressEvent,
  GitManagerCommitEntry,
  GitRunStackedActionResult,
  VcsStatusResult,
} from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createPullRequestAction,
  failCreatePullRequestProgress,
  presentCreatePullRequestProgress,
  reduceCreatePullRequestProgress,
  resolveCreatePullRequestReview,
  resolveProviderPanePresentation,
  REVIEW_PROGRESS,
  type CreatePullRequestProgress,
} from "./GitManagerPullRequestPanel.logic";

function status(overrides: Partial<VcsStatusResult> = {}): VcsStatusResult {
  return {
    isRepo: true,
    sourceControlProvider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
    hasPrimaryRemote: true,
    isDefaultRef: false,
    refName: "feature/reviewed",
    defaultRefName: "main",
    hasWorkingTreeChanges: false,
    workingTree: { files: [], insertions: 0, deletions: 0 },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  } as VcsStatusResult;
}

function latestCommit(subject: string, body = ""): GitManagerCommitEntry {
  return {
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    parents: [],
    decorations: [],
    subject,
    body,
    authorName: "Local",
    authorEmail: "local@example.test",
    authoredAtMs: 1,
    committerName: "Local",
    committerEmail: "local@example.test",
    committedAtMs: 1,
    changedFiles: [],
  };
}

const base = { actionId: "action-1", cwd: "/repo", action: "create_pr" } as const;

function finished(prStatus: "created" | "opened_existing"): GitActionProgressEvent {
  const result: GitRunStackedActionResult = {
    action: "create_pr",
    branch: { status: "skipped_not_requested" },
    commit: { status: "skipped_not_requested" },
    push: { status: "pushed", branch: "feature/reviewed" },
    pr: {
      status: prStatus,
      url: "https://github.com/owner/name/pull/7",
      number: 7,
      baseBranch: "main",
      headBranch: "feature/reviewed",
      title: "Reviewed",
    },
    toast: { title: "Git action completed", cta: { kind: "none" } },
  };
  return { ...base, kind: "action_finished", result };
}

describe("Git Manager provider pane logic", () => {
  it("starts not loaded and never implies an automatic request", () => {
    expect(
      resolveProviderPanePresentation({
        requested: false,
        pending: false,
        error: null,
        result: null,
      }),
    ).toEqual({
      kind: "not-loaded",
      message: "Pull requests and checks load only when you choose Refresh.",
    });
  });

  it("renders provider unavailability as explanatory content", () => {
    expect(
      resolveProviderPanePresentation({
        requested: true,
        pending: false,
        error: null,
        result: { status: "unavailable", pullRequests: [], checks: [] },
      }),
    ).toEqual({
      kind: "unavailable",
      message: "Pull requests or checks are unavailable for this repository provider.",
    });
  });

  it("keeps provider errors distinct from unavailable capability", () => {
    expect(
      resolveProviderPanePresentation({
        requested: true,
        pending: false,
        error: "Provider CLI failed.",
        result: null,
      }),
    ).toEqual({ kind: "error", message: "Provider CLI failed." });
  });

  it("reuses the existing stacked create-pr action shape with the reviewed fields", () => {
    expect(createPullRequestAction("action-1")).toEqual({
      actionId: "action-1",
      action: "create_pr",
    });
    expect(createPullRequestAction("action-2", { title: "  Reviewed  ", body: "Body\n" })).toEqual({
      actionId: "action-2",
      action: "create_pr",
      pullRequestTitle: "Reviewed",
      pullRequestBody: "Body\n",
    });
    expect(createPullRequestAction("action-3", { title: "Reviewed", body: "   " })).toEqual({
      actionId: "action-3",
      action: "create_pr",
      pullRequestTitle: "Reviewed",
    });
  });
});

describe("resolveCreatePullRequestReview", () => {
  it("describes repository, branches, publish requirement, and commit-based defaults", () => {
    const review = resolveCreatePullRequestReview({
      status: status(),
      latestCommit: latestCommit("feat: reviewed change", "Longer body\n"),
    });

    expect(review).toEqual({
      provider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
      head: "feature/reviewed",
      base: "main",
      publishRequired: true,
      existingPullRequest: null,
      defaultTitle: "feat: reviewed change",
      defaultBody: "Longer body",
      blockedReason: null,
    });
  });

  it("requires publishing only when the upstream is missing or behind the local branch", () => {
    expect(
      resolveCreatePullRequestReview({
        status: status({ hasUpstream: true, aheadCount: 0 }),
        latestCommit: null,
      }).publishRequired,
    ).toBe(false);
    expect(
      resolveCreatePullRequestReview({
        status: status({ hasUpstream: true, aheadCount: 2 }),
        latestCommit: null,
      }).publishRequired,
    ).toBe(true);
  });

  it("falls back to a branch-named title and surfaces an existing pull request", () => {
    const review = resolveCreatePullRequestReview({
      status: status({
        pr: {
          number: 9,
          title: "Existing",
          url: "https://github.com/owner/name/pull/9",
          baseRef: "main",
          headRef: "feature/reviewed",
          state: "open",
        },
      }),
      latestCommit: null,
    });

    expect(review.defaultTitle).toBe("Update feature/reviewed");
    expect(review.existingPullRequest).toEqual({
      number: 9,
      title: "Existing",
      url: "https://github.com/owner/name/pull/9",
    });
  });

  it.each([
    [status({ isRepo: false }), "This folder is not a Git repository."],
    [status({ refName: null }), "Check out a branch before creating a pull request."],
    [
      status({ sourceControlProvider: undefined }),
      "No supported source-control provider was found for this repository's remote.",
    ],
    [
      status({ hasWorkingTreeChanges: true }),
      "Commit local changes before creating a pull request.",
    ],
  ])("explains why creation is unavailable", (blockedStatus, reason) => {
    expect(
      resolveCreatePullRequestReview({ status: blockedStatus, latestCommit: null }).blockedReason,
    ).toBe(reason);
  });
});

describe("create pull request progress", () => {
  const review = { publishRequired: true, head: "feature/reviewed" };

  function run(events: ReadonlyArray<GitActionProgressEvent>): CreatePullRequestProgress {
    return events.reduce(reduceCreatePullRequestProgress, REVIEW_PROGRESS);
  }

  it("tracks publish then create and settles on the created pull request", () => {
    const running = run([
      { ...base, kind: "action_started", phases: ["push", "pr"] },
      { ...base, kind: "phase_started", phase: "push", label: "Pushing" },
    ]);
    expect(presentCreatePullRequestProgress(running, review)).toMatchObject({
      status: "Publishing feature/reviewed…",
      busy: true,
    });

    const creating = reduceCreatePullRequestProgress(running, {
      ...base,
      kind: "phase_started",
      phase: "pr",
      label: "Creating pull request",
    });
    expect(creating).toEqual({ kind: "running", phase: "pr", pushed: true });
    expect(presentCreatePullRequestProgress(creating, review).status).toBe(
      "Creating the pull request…",
    );

    const created = reduceCreatePullRequestProgress(creating, finished("created"));
    expect(created).toEqual({
      kind: "created",
      url: "https://github.com/owner/name/pull/7",
      number: 7,
    });
    expect(presentCreatePullRequestProgress(created, review)).toMatchObject({
      status: "Pull request #7 created.",
      primaryLabel: "Done",
      settled: true,
    });
  });

  it("distinguishes a publish failure from a creation failure after the branch was published", () => {
    const publishFailed = run([
      { ...base, kind: "action_started", phases: ["push", "pr"] },
      { ...base, kind: "phase_started", phase: "push", label: "Pushing" },
      { ...base, kind: "action_failed", phase: "push", message: "remote rejected" },
    ]);
    expect(publishFailed).toEqual({
      kind: "failed",
      phase: "push",
      message: "remote rejected",
      branchPublished: false,
    });
    expect(presentCreatePullRequestProgress(publishFailed, review)).toMatchObject({
      status: "Publishing feature/reviewed failed: remote rejected",
      tone: "error",
      primaryLabel: "Retry",
    });

    const createFailed = run([
      { ...base, kind: "action_started", phases: ["push", "pr"] },
      { ...base, kind: "phase_started", phase: "push", label: "Pushing" },
      { ...base, kind: "phase_started", phase: "pr", label: "Creating pull request" },
      { ...base, kind: "action_failed", phase: "pr", message: "gh exited 1" },
    ]);
    expect(createFailed).toEqual({
      kind: "failed",
      phase: "pr",
      message: "gh exited 1",
      branchPublished: true,
    });
    expect(presentCreatePullRequestProgress(createFailed, review).status).toBe(
      "feature/reviewed was published, but creating the pull request failed: gh exited 1",
    );
  });

  it("reports an existing pull request without creating another", () => {
    const existing = run([
      { ...base, kind: "action_started", phases: ["push", "pr"] },
      { ...base, kind: "phase_started", phase: "pr", label: "Creating pull request" },
      finished("opened_existing"),
    ]);
    expect(existing).toEqual({
      kind: "existing",
      url: "https://github.com/owner/name/pull/7",
      number: 7,
    });
    expect(presentCreatePullRequestProgress(existing, review).status).toBe(
      "Pull request #7 already exists for this branch, so none was created.",
    );
  });

  it("settles a transport failure without losing a published branch or a settled outcome", () => {
    const creating = run([
      { ...base, kind: "action_started", phases: ["push", "pr"] },
      { ...base, kind: "phase_started", phase: "push", label: "Pushing" },
      { ...base, kind: "phase_started", phase: "pr", label: "Creating pull request" },
    ]);
    expect(failCreatePullRequestProgress(creating, "connection lost")).toEqual({
      kind: "failed",
      phase: "pr",
      message: "connection lost",
      branchPublished: true,
    });
    const created = reduceCreatePullRequestProgress(creating, finished("created"));
    expect(failCreatePullRequestProgress(created, "late failure")).toBe(created);
    const reported = reduceCreatePullRequestProgress(creating, {
      ...base,
      kind: "action_failed",
      phase: "pr",
      message: "gh exited 1",
    });
    expect(failCreatePullRequestProgress(reported, "transport lost")).toBe(reported);
  });
});
