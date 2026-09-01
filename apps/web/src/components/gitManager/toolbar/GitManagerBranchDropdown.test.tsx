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
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <button>{children}</button>,
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
        projectRef={projectRef}
        recentNames={[]}
        refs={refs}
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
        blocked: [{ operation: "branch-checkout", code: "worktree-checked-out", message }],
      }),
    ]);

    await act(async () => rowButton("feature").click());

    expect(callbacks.onSwitchWorktree).toHaveBeenCalledWith("/opaque/feature");
    expect(callbacks.onSelectBranch).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Switch to worktree");
    expect(document.body.textContent).toContain("/opaque/feature");
  });

  it("renders a blocked row's server-authored message verbatim", async () => {
    const message = "Already checked out.";
    await renderDropdown([
      branch("main", {
        current: true,
        blocked: [{ operation: "branch-checkout", code: "current-branch", message }],
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
            operation: "branch-checkout",
            code: "future-policy" as never,
            message,
          },
        ],
      }),
    ]);

    expect(rowButton("future").disabled).toBe(true);
    expect(document.body.textContent).toContain(message);
  });
});
