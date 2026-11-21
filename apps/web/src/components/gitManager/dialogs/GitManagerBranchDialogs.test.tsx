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

const LOCAL_REFS = [branch("main", { current: true }), branch("feature")];
const REMOTE_REFS = [branch("origin/main"), branch("origin/release")];

async function renderCreate(
  base: {
    readonly baseBranch: string | null;
    readonly baseCommit: string | null;
    readonly unborn?: boolean;
  },
  refs: ReadonlyArray<GitManagerRefEntry> = LOCAL_REFS,
) {
  const submissions: GitManagerBranchDialogSubmission[] = [];
  await act(async () =>
    root?.render(
      <GitManagerBranchDialogs
        busy={false}
        dialog={{ kind: "create", ...base }}
        errorMessage={null}
        refs={refs}
        remoteRefs={REMOTE_REFS}
        onClose={() => undefined}
        onSubmit={(submission) => {
          submissions.push(submission);
          return Promise.resolve();
        }}
      />,
    ),
  );
  return submissions;
}

function sourceInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>("#git-manager-create-branch-source");
  if (!input) throw new Error("Missing source input");
  return input;
}

function checkoutBox(): HTMLElement & { checked: boolean } {
  const box = document.querySelector<HTMLElement>(
    '[data-testid="git-manager-create-branch-checkout"]',
  );
  if (!box) throw new Error("Missing checkout checkbox");
  return Object.assign(box, {
    get checked() {
      return box.getAttribute("aria-checked") === "true" || box.hasAttribute("data-checked");
    },
  });
}

/** The user's path: clicking the visible label. */
async function toggleCheckout() {
  await act(async () =>
    [...document.querySelectorAll("label")]
      .find((label) => label.textContent === "Check out after creating")!
      .click(),
  );
}

async function setInputValue(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function typeName(name: string) {
  const input = document.querySelector<HTMLInputElement>("#git-manager-create-branch-name");
  if (!input) throw new Error("Missing name input");
  await setInputValue(input, name);
  // Branch-name rules are debounced.
  await act(async () => new Promise((resolve) => setTimeout(resolve, 300)));
}

async function chooseSource(label: string) {
  await act(async () => {
    sourceInput().focus();
    sourceInput()
      .closest('[data-slot="input-control"]')
      ?.parentElement?.querySelector<HTMLButtonElement>('[data-slot="combobox-trigger"]')
      ?.click();
  });
  await setInputValue(sourceInput(), label);
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent?.trim() === label,
  );
  if (!option) throw new Error(`Missing source option: ${label}`);
  await act(async () => option.click());
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
              blocked: [{ operation: "rename-branch", code: "worktree-checked-out", message }],
            }),
          }}
          errorMessage={null}
          refs={[]}
          remoteRefs={[]}
          onClose={() => undefined}
          onSubmit={() => Promise.resolve()}
        />,
      ),
    );

    expect(document.body.textContent).toContain(message);
    expect(buttonWithText("Rename").disabled).toBe(true);
    expect(buttonWithText("Rename").parentElement?.title).toBe(message);
  });

  it("creates and checks out from the active branch by default", async () => {
    const submissions = await renderCreate({ baseBranch: "main", baseCommit: null });

    expect(sourceInput().value).toBe("main");
    expect(checkoutBox().checked).toBe(true);
    await typeName("feature/login");
    await act(async () => buttonWithText("Create and check out").click());

    expect(submissions).toEqual([
      { kind: "create", name: "feature/login", startPoint: "refs/heads/main", checkout: true },
    ]);
  });

  it("creates without checking out and says the active branch stays checked out", async () => {
    const submissions = await renderCreate({ baseBranch: "main", baseCommit: null });

    await toggleCheckout();
    expect(checkoutBox().checked).toBe(false);
    expect(document.body.textContent).toContain("You stay on main.");
    await typeName("feature/later");
    await act(async () => buttonWithText("Create branch").click());

    expect(submissions).toEqual([
      { kind: "create", name: "feature/later", startPoint: "refs/heads/main", checkout: false },
    ]);
  });

  it("creates from another local or remote branch chosen as the source", async () => {
    const submissions = await renderCreate({ baseBranch: "main", baseCommit: null });

    await chooseSource("origin/release");
    expect(sourceInput().value).toBe("origin/release");
    await typeName("hotfix/one");
    await act(async () => buttonWithText("Create and check out").click());
    await chooseSource("feature");
    await act(async () => buttonWithText("Create and check out").click());

    expect(
      submissions.map((submission) => submission.kind === "create" && submission.startPoint),
    ).toEqual(["refs/remotes/origin/release", "refs/heads/feature"]);
  });

  it("starts from the chosen commit when opened from History", async () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const submissions = await renderCreate({ baseBranch: null, baseCommit: sha });

    expect(sourceInput().value).toBe("Commit 0123456");
    await typeName("from-commit");
    await act(async () => buttonWithText("Create and check out").click());

    expect(submissions).toEqual([
      { kind: "create", name: "from-commit", startPoint: sha, checkout: true },
    ]);
  });

  it("starts from the current HEAD when it is detached", async () => {
    const submissions = await renderCreate({ baseBranch: null, baseCommit: null }, [
      branch("main"),
      branch("feature"),
    ]);

    expect(sourceInput().value).toBe("Current HEAD");
    await toggleCheckout();
    expect(document.body.textContent).toContain("You stay on the current commit.");
    await typeName("rescue");
    await act(async () => buttonWithText("Create branch").click());

    expect(submissions).toEqual([
      { kind: "create", name: "rescue", startPoint: null, checkout: false },
    ]);
  });

  it("on an unborn HEAD, lets a branch from an existing start point skip checkout", async () => {
    // An orphan checkout beside a committed `main`: Git creates from `main` without switching.
    const submissions = await renderCreate({ baseBranch: null, baseCommit: null, unborn: true }, [
      branch("main"),
    ]);
    await chooseSource("main");
    await toggleCheckout();
    expect(checkoutBox().checked).toBe(false);
    await typeName("topic");
    await act(async () => buttonWithText("Create branch").click());

    expect(submissions).toEqual([
      { kind: "create", name: "topic", startPoint: "refs/heads/main", checkout: false },
    ]);
  });

  it("before the first commit, switches to the new branch from the current HEAD", async () => {
    // Git can only start a branch on an unborn HEAD by switching to it.
    const submissions = await renderCreate(
      { baseBranch: null, baseCommit: null, unborn: true },
      [],
    );

    expect(sourceInput().value).toBe("Current HEAD");
    expect(checkoutBox().checked).toBe(true);
    expect(
      checkoutBox().getAttribute("aria-disabled") ??
        String(checkoutBox().hasAttribute("data-disabled")),
    ).toBe("true");
    expect(document.body.textContent).toContain("No commit exists yet");
    await toggleCheckout();
    expect(checkoutBox().checked).toBe(true);
    await typeName("topic");
    await act(async () => buttonWithText("Create and check out").click());

    expect(submissions).toEqual([
      { kind: "create", name: "topic", startPoint: null, checkout: true },
    ]);
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
          remoteRefs={[]}
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

  async function renderBranchDialog(
    dialog: React.ComponentProps<typeof GitManagerBranchDialogs>["dialog"],
  ) {
    const submissions: GitManagerBranchDialogSubmission[] = [];
    await act(async () =>
      root?.render(
        <GitManagerBranchDialogs
          busy={false}
          dialog={dialog}
          errorMessage={null}
          refs={[]}
          remoteRefs={[]}
          onClose={() => undefined}
          onSubmit={(submission) => {
            submissions.push(submission);
            return Promise.resolve();
          }}
        />,
      ),
    );
    return submissions;
  }

  async function confirmDelete() {
    const confirmation = document.querySelector<HTMLInputElement>('input[name="confirm-delete"]');
    if (!confirmation) throw new Error("Missing delete confirmation");
    await act(async () => confirmation.click());
  }

  const MERGE_DIRTY = {
    operation: "merge",
    code: "dirty-working-tree",
    message: "Merge is blocked: the working tree has uncommitted changes.",
  } as const;

  it("shows the server's delete reason among unrelated ones and sends nothing", async () => {
    const message = "Delete is blocked: this is the default branch.";
    const submissions = await renderBranchDialog({
      kind: "delete",
      branch: branch("main", {
        blocked: [MERGE_DIRTY, { operation: "delete-branch", code: "default-branch", message }],
      }),
      existsUpstream: false,
    });

    await confirmDelete();
    const deleteButton = buttonWithText("Delete branch");
    expect(document.body.textContent).toContain(message);
    expect(document.body.textContent).not.toContain(MERGE_DIRTY.message);
    expect(deleteButton.disabled).toBe(true);
    await act(async () => deleteButton.click());
    expect(submissions).toEqual([]);
  });

  it("blocks delete while an operation holds the repository", async () => {
    const message = "Blocked: a merge is in progress; resolve or abort it first.";
    await renderBranchDialog({
      kind: "delete",
      branch: branch("feature", {
        // The server emits both spellings for in-progress and lock-held reasons.
        blocked: [
          { operation: "branch-delete", code: "merge-in-progress", message },
          { operation: "delete-branch", code: "merge-in-progress", message },
        ],
      }),
      existsUpstream: false,
    });

    await confirmDelete();
    expect(buttonWithText("Delete branch").disabled).toBe(true);
    expect(document.body.textContent).toContain(message);
  });

  it("deletes and renames a branch that is blocked only for merge", async () => {
    const blocked = [MERGE_DIRTY];
    const deletions = await renderBranchDialog({
      kind: "delete",
      branch: branch("feature", { blocked }),
      existsUpstream: false,
    });
    await confirmDelete();
    await act(async () => buttonWithText("Delete branch").click());
    expect(deletions).toEqual([{ kind: "delete", name: "feature", deleteRemote: false }]);

    const renames = await renderBranchDialog({
      kind: "rename",
      branch: branch("feature", { blocked }),
    });
    expect(document.body.textContent).not.toContain(MERGE_DIRTY.message);
    const input = document.querySelector<HTMLInputElement>('input[aria-label="New branch name"]');
    await setInputValue(input!, "feature-two");
    await act(async () => buttonWithText("Rename").click());
    expect(renames).toEqual([{ kind: "rename", name: "feature", newName: "feature-two" }]);
  });

  async function renderRemoteDelete(
    remoteRefs: ReadonlyArray<GitManagerRefEntry>,
    extra: Partial<React.ComponentProps<typeof GitManagerBranchDialogs>> = {},
  ) {
    const submissions: GitManagerBranchDialogSubmission[] = [];
    await act(async () =>
      root?.render(
        <GitManagerBranchDialogs
          busy={false}
          dialog={{
            kind: "delete-remote",
            branch: branch("origin/feature/a"),
            remote: "origin",
            remoteBranch: "feature/a",
          }}
          errorMessage={null}
          refs={[]}
          remoteRefs={remoteRefs}
          onClose={() => undefined}
          onSubmit={(submission) => {
            submissions.push(submission);
            return Promise.resolve();
          }}
          {...extra}
        />,
      ),
    );
    return submissions;
  }

  it("confirms a remote branch delete that names the remote and keeps the local branch", async () => {
    const submissions = await renderRemoteDelete([branch("origin/feature/a")]);

    expect(document.querySelector("h2")?.textContent).toBe("Delete Remote Branch?");
    const text = document.body.textContent ?? "";
    expect(text).toContain("feature/a");
    expect(text).toContain("origin");
    expect(text).toContain("A local branch with the same name is kept.");
    expect(text).toContain("The remote may refuse to delete a protected branch.");
    const deleteButton = buttonWithText("Delete remote branch");
    expect(deleteButton.disabled).toBe(true);
    await act(async () => deleteButton.click());
    expect(submissions).toEqual([]);

    await confirmDelete();
    expect(deleteButton.disabled).toBe(false);
    await act(async () => deleteButton.click());
    expect(submissions).toEqual([{ kind: "delete-remote", remote: "origin", branch: "feature/a" }]);
  });

  it("sends nothing when the remote branch is gone from a newer snapshot", async () => {
    const submissions = await renderRemoteDelete([branch("origin/feature/a")]);
    await confirmDelete();
    await renderRemoteDelete([branch("origin/other")]);

    await act(async () => buttonWithText("Delete remote branch").click());
    expect(submissions).toEqual([]);
    expect(document.body.textContent).toContain("This remote branch no longer exists.");
  });

  it("blocks a remote branch that became the remote's default while the dialog was open", async () => {
    const submissions = await renderRemoteDelete([branch("origin/feature/a")]);
    await confirmDelete();
    await renderRemoteDelete([branch("origin/feature/a", { isDefault: true })]);

    await act(async () => buttonWithText("Delete remote branch").click());
    expect(submissions).toEqual([]);
    expect(document.body.textContent).toContain(
      "Delete is blocked: this is the remote's default branch.",
    );
  });

  it("shows the Git error inside the open dialog", async () => {
    const error = "remote: error: protected branch hook declined";
    await renderRemoteDelete([branch("origin/feature/a")], { errorMessage: error });

    expect(document.body.textContent).toContain(error);
  });

  // Round 2 (Codex 9): the confirmation says the server checks the remote's default first.
  it("says the server checks the remote's default branch before deleting", async () => {
    await renderRemoteDelete([branch("origin/feature/a")]);

    expect(document.body.textContent).toContain(
      "Before deleting, BiBCode asks the remote for its default branch and refuses to delete it.",
    );
  });

  // Round 2 (Antigravity 10, UI.md): during a sign-in each dialog shows the prompt alone, not
  // the raw Git stderr and the disabled reason stacked with it; the submit stays disabled.
  it.each([
    ["delete-remote", "Delete remote branch"],
    ["delete", "Delete branch"],
    ["create", "Create and check out"],
    ["rename", "Rename"],
  ] as const)("shows only the sign-in prompt in the %s dialog", async (kind, action) => {
    const stderr = "fatal: Cannot prompt because user interactivity has been disabled.";
    const reason = "Finish or cancel the sign-in first.";
    const dialog =
      kind === "delete-remote"
        ? {
            kind,
            branch: branch("origin/feature/a"),
            remote: "origin",
            remoteBranch: "feature/a",
          }
        : kind === "delete"
          ? { kind, branch: branch("feature"), existsUpstream: true }
          : kind === "create"
            ? { kind, baseBranch: "main", baseCommit: null }
            : { kind, branch: branch("feature") };
    await act(async () =>
      root?.render(
        <GitManagerBranchDialogs
          busy={false}
          dialog={dialog}
          disabledReason={reason}
          errorMessage={`Sign in to continue.\n${stderr}`}
          refs={[branch("main", { current: true })]}
          remoteRefs={[branch("origin/feature/a")]}
          signInPrompt={<p>Sign in to example.test?</p>}
          onClose={() => undefined}
          onSubmit={() => Promise.resolve()}
        />,
      ),
    );

    // The disabled button keeps its reason as a screen-reader description and a hover title.
    const visible = document.body.cloneNode(true) as HTMLElement;
    for (const hidden of visible.querySelectorAll(".sr-only")) hidden.remove();
    const text = visible.textContent ?? "";
    expect(text).toContain("Sign in to example.test?");
    expect(text).not.toContain(stderr);
    expect(text).not.toContain(reason);
    expect(buttonWithText(action).disabled).toBe(true);
  });

  it("shows the server's rename reason and not an unrelated one", async () => {
    const message =
      "Rename is blocked: the worktree at /opaque/feature has this branch checked out.";
    await renderBranchDialog({
      kind: "rename",
      branch: branch("feature", {
        blocked: [
          MERGE_DIRTY,
          { operation: "rename-branch", code: "worktree-checked-out", message },
        ],
      }),
    });

    const input = document.querySelector<HTMLInputElement>('input[aria-label="New branch name"]');
    await setInputValue(input!, "feature-two");
    expect(document.body.textContent).toContain(message);
    expect(document.body.textContent).not.toContain(MERGE_DIRTY.message);
    expect(buttonWithText("Rename").disabled).toBe(true);
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
