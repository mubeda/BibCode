import { describe, expect, expectTypeOf, it } from "vite-plus/test";

import { resolveSyncState, type SyncStateInput } from "./syncButton.logic";

describe("resolveSyncState", () => {
  it("disables sync while an operation is running", () => {
    expect(
      resolveSyncState({
        isOperationRunning: true,
        hasRemote: true,
        isUnborn: false,
        isDetached: false,
        aheadBehind: { ahead: 1, behind: 0 },
        forcePushRecommended: false,
      }),
    ).toMatchObject({ kind: "running", disabledReason: expect.any(String) });
  });

  it("explains that repository publishing is unavailable when no remote exists", () => {
    expect(
      resolveSyncState({
        isOperationRunning: false,
        hasRemote: false,
        isUnborn: false,
        isDetached: false,
        aheadBehind: null,
        forcePushRecommended: false,
      }),
    ).toMatchObject({ kind: "no-remote", disabledReason: expect.any(String) });
  });

  it("offers fetch for an unborn branch", () => {
    expect(
      resolveSyncState({
        isOperationRunning: false,
        hasRemote: true,
        isUnborn: true,
        isDetached: false,
        aheadBehind: null,
        forcePushRecommended: false,
        remote: "upstream",
      }),
    ).toMatchObject({ kind: "fetch-unborn", label: "Fetch upstream" });
  });

  it("disables branch publishing while HEAD is detached", () => {
    expect(
      resolveSyncState({
        isOperationRunning: false,
        hasRemote: true,
        isUnborn: false,
        isDetached: true,
        aheadBehind: null,
        forcePushRecommended: false,
      }),
    ).toMatchObject({ kind: "detached", disabledReason: expect.any(String) });
  });

  it("offers publish-branch when the current branch has no upstream", () => {
    expect(
      resolveSyncState({
        isOperationRunning: false,
        hasRemote: true,
        isUnborn: false,
        isDetached: false,
        aheadBehind: null,
        forcePushRecommended: false,
      }).kind,
    ).toBe("publish-branch");
  });

  it("offers fetch when the local and upstream refs are even", () => {
    expect(
      resolveSyncState({
        isOperationRunning: false,
        hasRemote: true,
        isUnborn: false,
        isDetached: false,
        aheadBehind: { ahead: 0, behind: 0 },
        forcePushRecommended: false,
        remote: "upstream",
      }),
    ).toMatchObject({ kind: "fetch", label: "Fetch upstream", ahead: 0, behind: 0 });
  });

  it("offers force-push only when the server reports genuine divergence", () => {
    const divergent = resolveSyncState({
      isOperationRunning: false,
      hasRemote: true,
      isUnborn: false,
      isDetached: false,
      aheadBehind: { ahead: 2, behind: 1 },
      forcePushRecommended: true,
    });
    const ordinaryAhead = resolveSyncState({
      isOperationRunning: false,
      hasRemote: true,
      isUnborn: false,
      isDetached: false,
      aheadBehind: { ahead: 2, behind: 0 },
      forcePushRecommended: false,
    });

    expect(divergent.kind).toBe("force-push");
    expect(ordinaryAhead.kind).not.toBe("force-push");
  });

  it("offers pull whenever the branch is behind and force-push is not recommended", () => {
    expect(
      resolveSyncState({
        isOperationRunning: false,
        hasRemote: true,
        isUnborn: false,
        isDetached: false,
        aheadBehind: { ahead: 1, behind: 3 },
        forcePushRecommended: false,
      }),
    ).toMatchObject({ kind: "pull", label: "Pull origin", ahead: 1, behind: 3 });
  });

  it("offers push for ordinary local-ahead state", () => {
    expect(
      resolveSyncState({
        isOperationRunning: false,
        hasRemote: true,
        isUnborn: false,
        isDetached: false,
        aheadBehind: { ahead: 4, behind: 0 },
        forcePushRecommended: false,
      }),
    ).toMatchObject({ kind: "push", label: "Push origin", ahead: 4, behind: 0 });
  });

  it("does not expose speculative pending-tag input without remote tag state", () => {
    expectTypeOf<SyncStateInput>().not.toHaveProperty("tagsToPush");
  });
});
