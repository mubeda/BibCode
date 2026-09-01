import { describe, expect, it } from "vite-plus/test";

import {
  advanceMultiCommitOperation,
  multiCommitConflictPresentation,
  type GitManagerMultiCommitState,
} from "./gitManagerMultiCommitOperation.logic";

function rebaseState(): GitManagerMultiCommitState {
  return {
    step: "choose-branch",
    kind: "rebase",
    selectedShas: ["commit-a", "commit-b"],
    selectedBranch: null,
    conflicts: [],
    continueBlocked: null,
    originalBranchTip: null,
    operationEvent: null,
    operationStartedExternally: false,
    abortRequested: false,
  };
}

describe("advanceMultiCommitOperation", () => {
  it("warns before rewriting pushed commits and otherwise advances to progress", () => {
    const pushed = advanceMultiCommitOperation(rebaseState(), {
      _tag: "branch-chosen",
      branch: "main",
      commitsArePushed: true,
    });
    const local = advanceMultiCommitOperation(rebaseState(), {
      _tag: "branch-chosen",
      branch: "main",
      commitsArePushed: false,
    });

    expect(pushed).toMatchObject({
      step: "warn-force-push",
      selectedBranch: "main",
    });
    expect(local).toMatchObject({
      step: "show-progress",
      selectedBranch: "main",
    });
  });

  it("opens the server conflict list after a conflict failure", () => {
    const conflicts = [
      { path: "src/a.ts", kind: "text", markerCount: 2, resolution: null },
    ] as const;
    const state = { ...rebaseState(), step: "show-progress" as const };

    const next = advanceMultiCommitOperation(state, {
      _tag: "failed",
      operation: "rebase",
      code: "conflicts-encountered",
      message: "Git stopped because the history rewrite produced conflicts.",
      blocked: null,
      conflicts,
    });

    expect(next.step).toBe("show-conflicts");
    expect(next.conflicts).toBe(conflicts);
  });

  it("continues only after every conflict is resolved and preserves a server block", () => {
    const blocked = {
      operation: "continue",
      code: "merge-in-progress",
      message: "Resolve and stage every conflicted path before continuing.",
    } as const;
    const unresolved = {
      ...rebaseState(),
      step: "show-conflicts" as const,
      conflicts: [{ path: "src/a.ts", kind: "text" as const, markerCount: 1, resolution: null }],
      continueBlocked: blocked,
    };
    const resolved = {
      ...unresolved,
      conflicts: [
        { path: "src/a.ts", kind: "text" as const, markerCount: 0, resolution: null },
        { path: "asset.bin", kind: "binary" as const, markerCount: 1, resolution: "ours" as const },
      ],
      continueBlocked: null,
    };

    expect(advanceMultiCommitOperation(unresolved, { _tag: "continue-requested" })).toBe(
      unresolved,
    );
    const unresolvedBinary = {
      ...resolved,
      conflicts: [{ path: "asset.bin", kind: "binary" as const, markerCount: 0, resolution: null }],
    };
    expect(advanceMultiCommitOperation(unresolvedBinary, { _tag: "continue-requested" })).toBe(
      unresolvedBinary,
    );
    expect(unresolved.continueBlocked.message).toBe(blocked.message);
    expect(advanceMultiCommitOperation(resolved, { _tag: "continue-requested" }).step).toBe(
      "show-progress",
    );
  });

  it("hides and reopens conflicts without abandoning the sticky operation state", () => {
    const conflicts = [
      { path: "src/a.ts", kind: "text" as const, markerCount: 1, resolution: null },
    ];
    const showing = { ...rebaseState(), step: "show-conflicts" as const, conflicts };

    const hidden = advanceMultiCommitOperation(showing, { _tag: "dismiss-conflicts" });
    expect(hidden).toMatchObject({
      step: "hide-conflicts",
      abortRequested: false,
    });
    expect(hidden.conflicts).toBe(conflicts);
    expect(multiCommitConflictPresentation(hidden)).toEqual({
      dialogOpen: false,
      bannerVisible: true,
      bannerDismissable: false,
    });

    const reopened = advanceMultiCommitOperation(hidden, { _tag: "view-conflicts" });
    expect(reopened.step).toBe("show-conflicts");
    expect(reopened.conflicts).toBe(conflicts);
  });

  it("routes abort through confirmation and returns to idle after the server finishes", () => {
    const running = { ...rebaseState(), step: "show-progress" as const };

    const confirming = advanceMultiCommitOperation(running, { _tag: "abort-requested" });
    expect(confirming).toMatchObject({ step: "confirm-abort", abortRequested: false });

    const aborting = advanceMultiCommitOperation(confirming, { _tag: "abort-confirmed" });
    expect(aborting).toMatchObject({ step: "show-progress", abortRequested: true });

    const idle = advanceMultiCommitOperation(aborting, {
      _tag: "finished",
      operation: "abort",
      message: "Rebase aborted.",
    });
    expect(idle).toMatchObject({ step: null, abortRequested: false });
  });

  it("captures the pre-operation tip from the first server start and never recomputes it", () => {
    const state = { ...rebaseState(), step: "show-progress" as const };
    const started = advanceMultiCommitOperation(state, {
      _tag: "started",
      operation: "rebase",
      originalBranchTip: "tip-before-rewrite",
    });
    const duplicate = advanceMultiCommitOperation(started, {
      _tag: "started",
      operation: "rebase",
      originalBranchTip: "later-tip-must-not-win",
    });

    expect(started.originalBranchTip).toBe("tip-before-rewrite");
    expect(duplicate.originalBranchTip).toBe("tip-before-rewrite");
  });

  it("accepts an externally started operation while locally idle", () => {
    const idle = { ...rebaseState(), step: null, kind: "merge" as const };

    const started = advanceMultiCommitOperation(idle, {
      _tag: "started",
      operation: "cherry-pick",
    });

    expect(started).toMatchObject({
      step: "show-progress",
      kind: "cherry-pick",
      operationStartedExternally: true,
    });
  });

  it("settles a cancelled progress stream instead of leaving the host open", () => {
    const running = { ...rebaseState(), step: "show-progress" as const };

    const cancelled = advanceMultiCommitOperation(running, { _tag: "cancelled" });

    expect(cancelled).toMatchObject({ step: null, abortRequested: false });
  });

  it("records output verbatim and settles a non-conflict failure", () => {
    const running = { ...rebaseState(), step: "show-progress" as const };
    const output = {
      _tag: "output" as const,
      operation: "rebase",
      stream: "stderr" as const,
      text: "chunk <kept> & verbatim\n",
    };

    const withOutput = advanceMultiCommitOperation(running, output);
    const failed = advanceMultiCommitOperation(withOutput, {
      _tag: "failed",
      operation: "rebase",
      code: "authentication",
      message: "Authentication failed.",
      blocked: null,
    });

    expect(withOutput.operationEvent).toBe(output);
    expect(failed).toMatchObject({
      step: null,
      operationEvent: { _tag: "failed", code: "authentication" },
    });
  });
});
