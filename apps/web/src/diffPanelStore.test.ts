import { scopeThreadRef } from "@bibcode/client-runtime/environment";
import { EnvironmentId, ThreadId, TurnId } from "@bibcode/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  selectThreadCompareFile,
  selectThreadCompareFilters,
  selectThreadDiffPanelRefreshRequest,
  selectThreadDiffPanelSelection,
  useDiffPanelStore,
} from "./diffPanelStore";

const THREAD_REF = scopeThreadRef(EnvironmentId.make("environment-1"), ThreadId.make("thread-1"));

describe("diffPanelStore", () => {
  beforeEach(() =>
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      gitRefreshRequestByThreadKey: {},
      compareFileByThreadKey: {},
      compareFiltersByThreadKey: {},
    }),
  );

  it("defaults each thread to branch changes with automatic base selection", () => {
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: null });
  });

  it("clears incompatible selection fields when changing scopes", () => {
    const store = useDiffPanelStore.getState();
    store.selectTurn(THREAD_REF, TurnId.make("turn-1"), "src/app.ts");
    store.selectGitScope(THREAD_REF, "unstaged");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "unstaged" });

    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, " origin/main ");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("increments the reveal request when opening the same turn file again", () => {
    const turnId = TurnId.make("turn-1");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, turnId, "src/app.ts");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "turn", turnId, filePath: "src/app.ts", revealRequestId: 2 });
  });

  it("restores the selected branch base after visiting another scope", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/main");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "unstaged");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: "origin/main" });
  });

  it("requests a fresh git preview whenever a scope is opened", () => {
    const store = useDiffPanelStore.getState();
    store.selectGitScope(THREAD_REF, "unstaged");
    store.selectGitScope(THREAD_REF, "unstaged");

    expect(
      selectThreadDiffPanelRefreshRequest(
        useDiffPanelStore.getState().gitRefreshRequestByThreadKey,
        THREAD_REF,
      ),
    ).toBe(2);
  });

  it("reconciles a missing turn selection to the latest available turn", () => {
    const missingTurnId = TurnId.make("turn-missing");
    const latestTurnId = TurnId.make("turn-latest");
    useDiffPanelStore.getState().selectTurn(THREAD_REF, missingTurnId, "src/app.ts");
    useDiffPanelStore.getState().reconcileTurnSelection(THREAD_REF, [latestTurnId]);

    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "turn",
      turnId: latestTurnId,
      filePath: "src/app.ts",
      revealRequestId: 1,
    });
  });

  it("handles absent refs, refresh maps, and blank selection values", () => {
    expect(selectThreadDiffPanelSelection({}, null)).toEqual({ kind: "branch", baseRef: null });
    expect(selectThreadDiffPanelRefreshRequest(undefined, THREAD_REF)).toBe(0);
    expect(selectThreadDiffPanelRefreshRequest({}, undefined)).toBe(0);

    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "   ");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({ kind: "branch", baseRef: null });

    useDiffPanelStore.getState().selectTurn(THREAD_REF, TurnId.make("turn-blank"), "   ");
    expect(
      selectThreadDiffPanelSelection(useDiffPanelStore.getState().byThreadKey, THREAD_REF),
    ).toEqual({
      kind: "turn",
      turnId: TurnId.make("turn-blank"),
      filePath: null,
      revealRequestId: 1,
    });
  });

  it("preserves branch selection metadata and initializes a missing refresh map", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/release");
    useDiffPanelStore.setState({ gitRefreshRequestByThreadKey: undefined } as never);

    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");

    expect(useDiffPanelStore.getState().branchBaseRefByThreadKey).toEqual({
      "environment-1:thread-1": "origin/release",
    });
    expect(useDiffPanelStore.getState().gitRefreshRequestByThreadKey).toEqual({
      "environment-1:thread-1": 1,
    });
  });

  it("leaves valid or non-turn selections unchanged during reconciliation", () => {
    const stateBefore = useDiffPanelStore.getState();
    stateBefore.reconcileTurnSelection(THREAD_REF, [TurnId.make("turn-1")]);
    expect(useDiffPanelStore.getState().byThreadKey).toEqual({});

    stateBefore.selectTurn(THREAD_REF, TurnId.make("turn-1"));
    const selected = useDiffPanelStore.getState().byThreadKey;
    useDiffPanelStore.getState().reconcileTurnSelection(THREAD_REF, []);
    useDiffPanelStore.getState().reconcileTurnSelection(THREAD_REF, [TurnId.make("turn-1")]);
    expect(useDiffPanelStore.getState().byThreadKey).toEqual(selected);
  });

  it("removes every thread-scoped selection map and ignores repeated removal", () => {
    useDiffPanelStore.getState().selectBranchBaseRef(THREAD_REF, "origin/main");
    useDiffPanelStore.getState().selectGitScope(THREAD_REF, "branch");
    useDiffPanelStore.getState().removeThread(THREAD_REF);

    expect(useDiffPanelStore.getState()).toMatchObject({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      gitRefreshRequestByThreadKey: {},
    });
    const before = useDiffPanelStore.getState();
    useDiffPanelStore.getState().removeThread(THREAD_REF);
    expect(useDiffPanelStore.getState()).toBe(before);
  });

  it("keeps one unsent comment per section, in memory, and clears its text with it", () => {
    const store = useDiffPanelStore.getState();
    const draft = {
      id: "draft-1",
      filePath: "src/app.ts",
      range: { start: 3, end: 3, side: "additions" as const },
      rangeLabel: "+3",
    };
    store.setCommentDraft(THREAD_REF, "unstaged", draft);
    store.setCommentDraftText("draft-1", "half-written");
    const state = useDiffPanelStore.getState();
    expect(state.commentDraftBySectionKey).toEqual({ "environment-1:thread-1:unstaged": draft });
    expect(state.commentDraftTextById).toEqual({ "draft-1": "half-written" });
    const persisted = useDiffPanelStore.persist.getOptions().partialize?.(state) as Record<
      string,
      unknown
    >;
    expect(persisted).not.toHaveProperty("commentDraftBySectionKey");
    expect(persisted).not.toHaveProperty("commentDraftTextById");

    useDiffPanelStore.getState().setCommentDraft(THREAD_REF, "unstaged", null);
    expect(useDiffPanelStore.getState()).toMatchObject({
      commentDraftBySectionKey: {},
      commentDraftTextById: {},
    });
    const cleared = useDiffPanelStore.getState();
    useDiffPanelStore.getState().setCommentDraft(THREAD_REF, "unstaged", null);
    expect(useDiffPanelStore.getState()).toBe(cleared);
  });

  it("remembers Compare's file per thread, and its filters only in memory", () => {
    const store = useDiffPanelStore.getState();
    expect(selectThreadCompareFile(store.compareFileByThreadKey, THREAD_REF)).toBeNull();
    expect(selectThreadCompareFilters(store.compareFiltersByThreadKey, THREAD_REF)).toEqual({
      status: "all",
      query: "",
    });
    store.selectCompareFile(THREAD_REF, "src/app.ts");
    store.setCompareFilters(THREAD_REF, { status: "added", query: "app" });

    const state = useDiffPanelStore.getState();
    expect(selectThreadCompareFile(state.compareFileByThreadKey, THREAD_REF)).toBe("src/app.ts");
    expect(selectThreadCompareFilters(state.compareFiltersByThreadKey, THREAD_REF)).toEqual({
      status: "added",
      query: "app",
    });
    const persisted = useDiffPanelStore.persist.getOptions().partialize?.(state) as Record<
      string,
      unknown
    >;
    expect(persisted).toHaveProperty("compareFileByThreadKey", {
      ["environment-1:thread-1"]: "src/app.ts",
    });
    expect(persisted, "a reload never opens Compare with files hidden").not.toHaveProperty(
      "compareFiltersByThreadKey",
    );

    useDiffPanelStore.getState().removeThread(THREAD_REF);
    expect(useDiffPanelStore.getState()).toMatchObject({
      compareFileByThreadKey: {},
      compareFiltersByThreadKey: {},
    });
  });
});
