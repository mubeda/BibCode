// @vitest-environment happy-dom

import type { GitManagerRefEntry } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("~/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: React.ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <header>{children}</header>,
  DialogPopup: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

import {
  GitManagerBranchDialogs,
  type GitManagerBranchDialogSubmission,
} from "./GitManagerBranchDialogs";
import { GitManagerSwitchWithChangesDialog } from "./GitManagerSwitchWithChangesDialog";

function branch(name: string, options: Partial<GitManagerRefEntry> = {}): GitManagerRefEntry {
  return {
    name,
    tipSha: `${name}-sha`,
    upstream: null,
    ahead: 0,
    behind: 0,
    current: false,
    isDefault: false,
    worktreePath: null,
    blocked: [],
    ...options,
  };
}

let container: HTMLDivElement;
let root: Root | null;

function buttonWithText(text: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === text,
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing button: ${text}`);
  return button;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
});

describe("GitManagerBranchDialogs", () => {
  it("renders a server-authored rename block verbatim and disables submit", async () => {
    const message = "Rename is blocked because /opaque/feature holds this branch.";
    await act(async () =>
      root?.render(
        <GitManagerBranchDialogs
          busy={false}
          dialog={{
            kind: "rename",
            branch: branch("feature", {
              blocked: [{ operation: "branch-rename", code: "worktree-checked-out", message }],
            }),
          }}
          errorMessage={null}
          refs={[]}
          onClose={() => undefined}
          onSubmit={() => Promise.resolve()}
        />,
      ),
    );

    expect(document.body.textContent).toContain(message);
    expect(buttonWithText("Rename").disabled).toBe(true);
    expect(buttonWithText("Rename").title).toBe(message);
  });

  it("requires explicit confirmation before deleting a branch", async () => {
    const submissions: GitManagerBranchDialogSubmission[] = [];
    await act(async () =>
      root?.render(
        <GitManagerBranchDialogs
          busy={false}
          dialog={{ kind: "delete", branch: branch("old-feature"), existsUpstream: true }}
          errorMessage={null}
          refs={[]}
          onClose={() => undefined}
          onSubmit={(submission) => {
            submissions.push(submission);
            return Promise.resolve();
          }}
        />,
      ),
    );

    const deleteButton = buttonWithText("Delete branch");
    expect(deleteButton.disabled).toBe(true);
    expect(document.body.textContent).toContain("cannot be undone");

    const confirmation = document.querySelector('input[name="confirm-delete"]');
    expect(confirmation).toBeInstanceOf(HTMLInputElement);
    await act(async () => (confirmation as HTMLInputElement).click());
    expect(deleteButton.disabled).toBe(false);
    await act(async () => deleteButton.click());

    expect(submissions).toEqual([{ kind: "delete", name: "old-feature", deleteRemote: false }]);
  });
});

describe("GitManagerSwitchWithChangesDialog", () => {
  it("resolves both switch strategies with visible stash semantics", async () => {
    const onResolve = vi.fn(() => Promise.resolve());
    await act(async () =>
      root?.render(
        <GitManagerSwitchWithChangesDialog
          branchName="feature"
          busy={false}
          open
          onOpenChange={() => undefined}
          onResolve={onResolve}
        />,
      ),
    );

    expect(document.body.textContent).toContain("ordinary, visible stash entry");
    await act(async () => buttonWithText("Leave my changes").click());
    await act(async () => buttonWithText("Bring my changes").click());

    expect(onResolve).toHaveBeenNthCalledWith(1, { strategy: "stash" });
    expect(onResolve).toHaveBeenNthCalledWith(2, { strategy: "bring" });
  });
});
