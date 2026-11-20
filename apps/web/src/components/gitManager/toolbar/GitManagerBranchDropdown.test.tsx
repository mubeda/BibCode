// @vitest-environment happy-dom

import type { GitManagerRefEntry, ScopedProjectRef } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useGitManagerStore } from "../../../gitManagerStore";

vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    estimatedItemSize,
    renderItem,
  }: {
    data: ReadonlyArray<unknown>;
    estimatedItemSize: number;
    renderItem: (input: { item: unknown; index: number }) => React.ReactNode;
  }) => (
    <div data-estimated-item-size={estimatedItemSize}>
      {data.map((item, index) => (
        <div key={JSON.stringify(item)}>{renderItem({ item, index })}</div>
      ))}
    </div>
  ),
}));

vi.mock("~/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
  PopoverPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { GitManagerBranchDropdown } from "./GitManagerBranchDropdown";

const projectRef = {
  environmentId: "environment-1",
  projectId: "project-1",
} as ScopedProjectRef;

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

function rowButton(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes(name),
  );
  if (!(button instanceof HTMLButtonElement)) throw new Error(`Missing branch row: ${name}`);
  return button;
}

async function renderDropdown(
  refs: ReadonlyArray<GitManagerRefEntry>,
  overrides: Partial<React.ComponentProps<typeof GitManagerBranchDropdown>> = {},
) {
  const callbacks = {
    onSelectBranch: vi.fn(),
    onSwitchWorktree: vi.fn(),
    onCreateBranch: vi.fn(),
    onMergeInto: vi.fn(),
  };
  await act(async () =>
    root?.render(
      <GitManagerBranchDropdown
        currentBranchName="main"
        branchDisabledReason={null}
        mergeDisabledReason={null}
        triggerDisabledReason={null}
        noBranchLabel="Detached HEAD"
        projectRef={projectRef}
        recentNames={[]}
        refs={refs}
        remoteRefs={[]}
        selectedWorktreeCwd="/opaque/main"
        {...callbacks}
        {...overrides}
      />,
    ),
  );
  return callbacks;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  useGitManagerStore.setState({ byProjectKey: {}, toolbarByProjectKey: {} });
  // The list renders only while the picker is open (#360); these cases inspect its rows.
  useGitManagerStore.getState().setOpenDropdown(projectRef, "branch");
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

describe("GitManagerBranchDropdown", () => {
  it.each(["codex/delivery-retry-light", "codex/" + "owned-long-branch-".repeat(24)])(
    "keeps footer actions bounded while preserving full branch identity and disabled explanation: %s",
    async (current) => {
      const reason = "An owned operation is still running.";
      await renderDropdown([branch(current, { current: true })], {
        currentBranchName: current,
        mergeDisabledReason: reason,
      });
      const merge = rowButton("Choose a branch to merge into " + current);
      const create = rowButton("New branch");
      expect(merge.disabled).toBe(true);
      expect(merge.parentElement?.title).toBe(reason);
      expect(merge.textContent).toContain(current);
      const text = Array.from(merge.children).find((child) => child.tagName === "SPAN");
      expect(text).toBeDefined();
      expect(text!.textContent).toBe("Choose a branch to merge into " + current);
      const { compile } = await import("tailwindcss");
      const style = document.createElement("style");
      style.textContent = (
        await compile("@theme { --spacing: 0.25rem; } @tailwind utilities;")
      ).build([...create.classList, ...merge.classList, ...text!.classList]);
      document.head.append(style);
      try {
        expect(getComputedStyle(create).minWidth).toBe("0px");
        expect(getComputedStyle(merge).minWidth).toBe("0px");
        expect(getComputedStyle(text!).minWidth).toBe("0px");
        expect(getComputedStyle(text!).overflow).toBe("hidden");
        expect(getComputedStyle(text!).textOverflow).toBe("ellipsis");
        expect(getComputedStyle(text!).whiteSpace).toBe("nowrap");
      } finally {
        style.remove();
      }
    },
  );

  it("disables its trigger with an accessible explanation while the repository is unavailable", async () => {
    const reason =
      "Git can't read this repository. Check its .git folder, for example a damaged HEAD or config file.";
    await renderDropdown([], {
      currentBranchName: null,
      noBranchLabel: "No branch",
      triggerDisabledReason: reason,
    });
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Choose branch"]');
    expect(trigger).toMatchObject({ disabled: true, title: reason, textContent: "No branch" });
    expect(document.getElementById(trigger!.getAttribute("aria-describedby")!)?.textContent).toBe(
      reason,
    );
  });
  it("keeps filter updates isolated from the panel view-state subscription", () => {
    useGitManagerStore.getState().touchProject(projectRef);
    const panelViewState = useGitManagerStore.getState().selectViewState(projectRef);

    useGitManagerStore.getState().setBranchFilterText(projectRef, "feature");

    expect(useGitManagerStore.getState().selectViewState(projectRef)).toBe(panelViewState);
    expect(useGitManagerStore.getState().selectToolbarViewState(projectRef).branchFilterText).toBe(
      "feature",
    );
  });

  it("redirects an occupied branch to its worktree without issuing checkout", async () => {
    const message = "Branch is checked out in worktree at /opaque/feature.";
    const callbacks = await renderDropdown([
      branch("feature", {
        worktreePath: "/opaque/feature",
        blocked: [{ operation: "checkout", code: "worktree-checked-out", message }],
      }),
    ]);
    expect(document.body.textContent).toContain("Switch to worktree");
    expect(document.body.textContent).toContain("/opaque/feature");

    await act(async () => rowButton("feature").click());

    expect(callbacks.onSwitchWorktree).toHaveBeenCalledWith("/opaque/feature");
    expect(callbacks.onSelectBranch).not.toHaveBeenCalled();
  });

  it("renders a blocked row's server-authored message verbatim", async () => {
    const message = "Already checked out.";
    await renderDropdown([
      branch("main", {
        current: true,
        blocked: [{ operation: "checkout", code: "current-branch", message }],
      }),
    ]);

    const button = document.querySelector(`button[title="${message}"]`);
    expect(button).toBeInstanceOf(HTMLButtonElement);
    if (!(button instanceof HTMLButtonElement)) throw new Error("Missing blocked branch row");
    expect(button.disabled).toBe(true);
    expect(button.title).toBe(message);
    expect(document.getElementById(button.getAttribute("aria-describedby")!)?.textContent).toBe(
      message,
    );
  });

  it("fails closed when the server sends an unknown blocked code", async () => {
    const message = "A newer server guard blocked this branch.";
    await renderDropdown([
      branch("future", {
        blocked: [
          {
            operation: "checkout",
            code: "future-policy" as never,
            message,
          },
        ],
      }),
    ]);

    expect(rowButton("future").disabled).toBe(true);
    expect(document.body.textContent).toContain(message);
  });

  it("disables branch mutations with their reason while merge and worktree surfaces remain", async () => {
    const reason = "This environment does not support Git Manager branch and sync operations.";
    const callbacks = await renderDropdown([branch("feature")], {
      branchDisabledReason: reason,
    });

    expect(rowButton("feature")).toMatchObject({ disabled: true, title: reason });
    expect(
      document.querySelector<HTMLButtonElement>('[aria-label="Rename feature"]'),
    ).toMatchObject({ disabled: true, title: reason });
    expect(
      document.querySelector<HTMLButtonElement>('[aria-label="Delete feature"]'),
    ).toMatchObject({ disabled: true, title: reason });
    expect(document.body.textContent).toContain(reason);

    const merge = rowButton("Choose a branch to merge into main");
    expect(merge.disabled).toBe(false);
    await act(async () => merge.click());
    expect(rowButton("feature").disabled).toBe(false);
    await act(async () => rowButton("feature").click());
    expect(callbacks.onMergeInto).toHaveBeenCalledWith(
      expect.objectContaining({ name: "feature" }),
    );
    expect(callbacks.onSelectBranch).not.toHaveBeenCalled();
  });

  it("disables merge with its reason while ordinary branch checkout remains available", async () => {
    const reason = "This environment does not support Git Manager stash and merge operations.";
    const callbacks = await renderDropdown([branch("feature")], {
      mergeDisabledReason: reason,
    });

    const merge = rowButton("Choose a branch to merge into main");
    expect(merge.disabled).toBe(true);
    expect(merge.parentElement?.title).toBe(reason);
    expect(document.body.textContent).toContain(reason);
    expect(rowButton("feature").disabled).toBe(false);
    await act(async () => rowButton("feature").click());
    expect(callbacks.onSelectBranch).toHaveBeenCalledWith(
      expect.objectContaining({ name: "feature" }),
      false,
    );
  });

  it("offers remote checkout without local rename/delete actions, including matching local names", async () => {
    const remote = branch("origin/develop");
    useGitManagerStore.getState().setBranchFilterText(projectRef, "Develop");
    const callbacks = await renderDropdown([branch("origin/develop")], {
      remoteRefs: [remote, branch("upstream/develop"), branch("origin/main")],
    });

    expect(container.textContent).toContain("Remote branches");
    expect(container.textContent).not.toContain("origin/main");
    expect(container.querySelectorAll('[aria-label="Rename origin/develop"]')).toHaveLength(1);
    expect(container.querySelectorAll('[aria-label="Delete origin/develop"]')).toHaveLength(1);
    expect(container.querySelector('[aria-label="Rename upstream/develop"]')).toBeNull();
    const remoteButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Check out remote branch origin/develop"]',
    );
    expect(remoteButton).not.toBeNull();
    await act(async () => remoteButton!.click());
    expect(callbacks.onSelectBranch).toHaveBeenCalledWith(remote, true);

    await act(async () => rowButton("Choose a branch to merge into main").click());
    expect(container.textContent).not.toContain("Remote branches");
  });

  it("offers Delete and no Rename on a remote row", async () => {
    const onDeleteRemoteBranch = vi.fn();
    const remote = branch("origin/feature/a");
    await renderDropdown([], {
      remoteRefs: [remote],
      remotes: ["origin"],
      onDeleteRemoteBranch,
    });

    expect(container.querySelector('[aria-label="Rename origin/feature/a"]')).toBeNull();
    const deleteButton = container.querySelector<HTMLButtonElement>(
      '[aria-label="Delete remote branch origin/feature/a"]',
    );
    expect(deleteButton?.disabled).toBe(false);
    await act(async () => deleteButton!.click());
    expect(onDeleteRemoteBranch).toHaveBeenCalledWith(remote);
  });

  it.each([
    [
      "the remote's default branch",
      branch("upstream/trunk", { isDefault: true }),
      ["origin", "upstream"],
      "Delete is blocked: this is the remote's default branch.",
    ],
    [
      "a name two remotes match",
      branch("team/fork/x"),
      ["team", "team/fork"],
      "Delete is blocked: two remotes match this name. Delete it from a terminal.",
    ],
  ])(
    "disables Delete on %s with a visible, described reason",
    async (_, remote, remotes, reason) => {
      const onDeleteRemoteBranch = vi.fn();
      await renderDropdown([], { remoteRefs: [remote], remotes, onDeleteRemoteBranch });

      const deleteButton = container.querySelector<HTMLButtonElement>(
        `[aria-label="Delete remote branch ${remote.name}"]`,
      );
      expect(deleteButton).toMatchObject({ disabled: true, title: reason });
      expect(container.textContent).toContain(reason);
      const describedBy = deleteButton!.getAttribute("aria-describedby")!.split(" ");
      expect(describedBy.map((id) => document.getElementById(id)?.textContent)).toContain(reason);
      await act(async () => deleteButton!.click());
      expect(onDeleteRemoteBranch).not.toHaveBeenCalled();
      // Checkout of the remote row is a different action and stays available.
      expect(
        container.querySelector<HTMLButtonElement>(
          `[aria-label="Check out remote branch ${remote.name}"]`,
        )?.disabled,
      ).toBe(false);
    },
  );

  const dirty = (operation: string, label: string) => ({
    operation,
    code: "dirty-working-tree" as const,
    message: `${label} is blocked: the working tree has uncommitted changes.`,
  });

  it("lets a dirty checkout through to the Stash or Bring choice", async () => {
    const callbacks = await renderDropdown([
      branch("feature", {
        blocked: [
          dirty("checkout", "Checkout"),
          dirty("merge", "Merge"),
          dirty("rebase", "Rebase"),
        ],
      }),
    ]);

    expect(rowButton("feature").disabled).toBe(false);
    await act(async () => rowButton("feature").click());
    expect(callbacks.onSelectBranch).toHaveBeenCalledWith(
      expect.objectContaining({ name: "feature" }),
      false,
    );
  });

  it("does not stop checkout for a merge, rebase or push reason", async () => {
    const callbacks = await renderDropdown([
      branch("feature", {
        blocked: [
          dirty("merge", "Merge"),
          dirty("rebase", "Rebase"),
          {
            operation: "push",
            code: "no-upstream",
            message: "Push is blocked: this branch has no upstream.",
          },
        ],
      }),
    ]);

    expect(rowButton("feature").disabled).toBe(false);
    expect(document.body.textContent).not.toContain("Merge is blocked");
    await act(async () => rowButton("feature").click());
    expect(callbacks.onSelectBranch).toHaveBeenCalledTimes(1);
  });

  it("shows a real checkout block ahead of unrelated reasons", async () => {
    const message = "Blocked: another Git Manager operation is already running.";
    const callbacks = await renderDropdown([
      branch("feature", {
        blocked: [
          dirty("merge", "Merge"),
          { operation: "checkout", code: "operation-in-flight", message },
        ],
      }),
    ]);

    const row = rowButton("feature");
    expect(row).toMatchObject({ disabled: true, title: message });
    expect(document.getElementById(row.getAttribute("aria-describedby")!)?.textContent).toBe(
      message,
    );
    await act(async () => row.click());
    expect(callbacks.onSelectBranch).not.toHaveBeenCalled();
  });

  it("still redirects a worktree-held branch whose checkout is also dirty", async () => {
    const callbacks = await renderDropdown([
      branch("held", {
        worktreePath: "/opaque/held",
        blocked: [
          dirty("checkout", "Checkout"),
          {
            operation: "checkout",
            code: "worktree-checked-out",
            message: "Checkout is blocked: this branch is already checked out in the worktree.",
          },
        ],
      }),
    ]);

    await act(async () => rowButton("held").click());
    expect(callbacks.onSwitchWorktree).toHaveBeenCalledWith("/opaque/held");
    expect(callbacks.onSelectBranch).not.toHaveBeenCalled();
  });

  it("in merge mode, blocks a branch with the merge reason only", async () => {
    const merge = dirty("merge", "Merge");
    const callbacks = await renderDropdown([
      branch("main", { current: true }),
      branch("feature", { blocked: [dirty("checkout", "Checkout"), merge] }),
      branch("clean", {
        blocked: [
          {
            operation: "push",
            code: "no-upstream",
            message: "Push is blocked: this branch has no upstream.",
          },
        ],
      }),
    ]);

    await act(async () => rowButton("Choose a branch to merge into main").click());
    expect(rowButton("feature")).toMatchObject({ disabled: true, title: merge.message });
    await act(async () => rowButton("clean").click());
    expect(callbacks.onMergeInto).toHaveBeenCalledWith(expect.objectContaining({ name: "clean" }));
  });
});
