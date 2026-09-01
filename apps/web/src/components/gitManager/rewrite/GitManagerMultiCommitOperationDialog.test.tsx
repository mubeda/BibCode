// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { GitManagerMultiCommitOperationDialog } from "./GitManagerMultiCommitOperationDialog";
import type {
  GitManagerMultiCommitEvent,
  GitManagerMultiCommitState,
} from "./gitManagerMultiCommitOperation.logic";

function state(overrides: Partial<GitManagerMultiCommitState> = {}): GitManagerMultiCommitState {
  return {
    step: "show-progress",
    kind: "rebase",
    selectedShas: ["commit-a", "commit-b"],
    selectedBranch: "main",
    conflicts: [],
    continueBlocked: null,
    originalBranchTip: "tip-before-rewrite",
    operationEvent: { _tag: "started", operation: "rebase" },
    operationStartedExternally: false,
    abortRequested: false,
    ...overrides,
  };
}

describe("GitManagerMultiCommitOperationDialog", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function renderDialog(
    operationState: GitManagerMultiCommitState,
    callbacks: {
      onAdvance?: (event: GitManagerMultiCommitEvent) => void;
      onCancel?: () => void;
      onConfirmAbort?: () => void;
    } = {},
  ) {
    const onAdvance = callbacks.onAdvance ?? vi.fn();
    const onCancel = callbacks.onCancel ?? vi.fn();
    const onConfirmAbort = callbacks.onConfirmAbort ?? vi.fn();
    await act(async () =>
      root.render(
        <GitManagerMultiCommitOperationDialog
          state={operationState}
          onAdvance={onAdvance}
          onCancel={onCancel}
          onConfirmAbort={onConfirmAbort}
        />,
      ),
    );
    return { onAdvance, onCancel, onConfirmAbort };
  }

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("uses an explicit destructive warning before a pushed rewrite", async () => {
    await renderDialog(state({ step: "warn-force-push" }));

    expect(document.body.textContent).toContain("History will be rewritten");
    expect(document.body.textContent).toContain("force push will be needed");
    const confirm = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Rewrite History",
    );
    expect(confirm?.className).toContain("border-destructive");
  });

  it("shows structured commit progress and collapsed verbatim command output", async () => {
    const onCancel = vi.fn();
    await renderDialog(
      state({
        inProgressOperation: { kind: "rebase", current: 2, total: 5 },
        operationEvent: {
          _tag: "output",
          operation: "rebase",
          stream: "stderr",
          text: "chunk <kept> & verbatim\n",
        },
      }),
      { onCancel },
    );

    expect(document.body.textContent).toContain("Commit 2 of 5");
    expect(document.body.textContent).not.toContain("%");
    const output = document.body.querySelector<HTMLElement>("[data-operation-output]");
    expect(output?.hidden).toBe(true);
    expect(output?.textContent).toContain("chunk <kept> & verbatim\n");

    const cancel = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Cancel",
    );
    await act(async () => cancel?.click());
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("hosts conflict recovery and confirmed abort without a parallel progress banner", async () => {
    const onConfirmAbort = vi.fn();
    await renderDialog(
      state({
        step: "confirm-abort",
        inProgressOperation: { kind: "rebase", current: 2, total: 5 },
      }),
      { onConfirmAbort },
    );

    const abort = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "Abort Rebase",
    );
    await act(async () => abort?.click());
    expect(onConfirmAbort).toHaveBeenCalledOnce();
    expect(document.body.querySelectorAll('[role="status"]')).toHaveLength(0);
  });

  it("groups branch choices and presents the server merge preview", async () => {
    const onAdvance = vi.fn<(event: GitManagerMultiCommitEvent) => void>();
    const refs = [
      {
        name: "main",
        tipSha: "tip-main",
        upstream: "origin/main",
        ahead: 0,
        behind: 0,
        current: true,
        isDefault: true,
        worktreePath: "/repo",
        blocked: [],
      },
      {
        name: "feature/rewrite",
        tipSha: "tip-feature",
        upstream: null,
        ahead: 2,
        behind: 1,
        current: false,
        isDefault: false,
        worktreePath: null,
        blocked: [],
      },
    ];
    const operationState = Object.assign(state({ step: "choose-branch" }), {
      refs,
      recentNames: ["feature/rewrite"],
      mergePreview: {
        _tag: "conflicted" as const,
        source: "feature/rewrite",
        current: "main",
        ahead: 2,
        behind: 1,
        fileCount: 3,
      },
      commitsArePushed: true,
    });

    await renderDialog(operationState, { onAdvance });

    expect(document.body.textContent).toContain("Recent");
    expect(document.body.textContent).toContain("feature/rewrite");
    expect(document.body.textContent).toContain("There will be 3 conflicted files.");
    const branch = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "feature/rewrite",
    );
    await act(async () => branch?.click());
    expect(onAdvance).toHaveBeenCalledWith({
      _tag: "branch-chosen",
      branch: "feature/rewrite",
      commitsArePushed: true,
    });
  });

  it("hosts conflict actions and keeps dismissed conflicts behind a sticky View link", async () => {
    const onAdvance = vi.fn<(event: GitManagerMultiCommitEvent) => void>();
    const blocked = {
      operation: "continue",
      code: "merge-in-progress",
      message: "Server says every conflicted path must be staged.",
    } as const;
    const conflicts = [
      { path: "asset.bin", kind: "binary" as const, markerCount: 0, resolution: null },
    ];
    await renderDialog(state({ step: "show-conflicts", conflicts, continueBlocked: blocked }), {
      onAdvance,
    });

    await act(async () =>
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Resolve asset.bin with theirs"]')
        ?.click(),
    );
    expect(onAdvance).toHaveBeenCalledWith({
      _tag: "resolve-conflict-requested",
      path: "asset.bin",
      side: "theirs",
    });

    await renderDialog(state({ step: "hide-conflicts", conflicts }), { onAdvance });
    expect(document.body.querySelectorAll('[role="alert"]')).toHaveLength(1);
    const view = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "View Conflicts",
    );
    await act(async () => view?.click());
    expect(onAdvance).toHaveBeenCalledWith({ _tag: "view-conflicts" });
  });

  it("keeps a server-blocked branch visible with its accessible verbatim reason", async () => {
    const message = "Server says this branch is checked out in another worktree.";
    const operationState = Object.assign(state({ step: "choose-branch" }), {
      refs: [
        {
          name: "held/rewrite",
          tipSha: "tip-held",
          upstream: null,
          ahead: 1,
          behind: 0,
          current: false,
          isDefault: false,
          worktreePath: "/held",
          blocked: [{ operation: "rebase", code: "worktree-checked-out", message }],
        },
      ],
    });

    await renderDialog(operationState);

    const branch = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Choose branch held/rewrite"]',
    );
    expect(branch).toMatchObject({ disabled: true, title: message });
    expect(branch?.getAttribute("aria-describedby")).toBe(
      "git-manager-branch-choice-tip-held-reason",
    );
    expect(document.body.textContent).toContain(message);
  });
});
