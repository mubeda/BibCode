// @vitest-environment happy-dom

import type {
  GitManagerRefEntry,
  GitManagerOperationEvent,
  GitManagerRefsSnapshot,
  VcsWorktreeDescriptor,
} from "@bibcode/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useGitManagerStore } from "../../gitManagerStore";

const h = vi.hoisted(() => ({
  selectProps: null as Record<string, unknown> | null,
  itemProps: [] as Array<Record<string, unknown>>,
  snapshot: null as GitManagerRefsSnapshot | null,
  refreshRefs: vi.fn(),
  tagDialogProps: [] as Array<Record<string, unknown>>,
  branchDialogProps: [] as Array<Record<string, unknown>>,
  menuItemProps: [] as Array<Record<string, unknown>>,
  refsAtom: vi.fn(() => ({ kind: "refs" })),
  signalAtom: vi.fn(() => ({ kind: "signal" })),
  runOperation: vi.fn(),
  failureMessage: null as string | null,
  /** Failures for one operation tag only; `failureMessage` fails every operation. */
  failures: {} as Record<string, { readonly code: string; readonly message: string }>,
  /** Full event sequences for one operation tag, emitted in order; the last one settles it. */
  events: {} as Record<string, ReadonlyArray<GitManagerOperationEvent>>,
  runSignIn: vi.fn(),
}));

vi.mock("../../state/gitManager", () => ({
  runGitManagerOperation: h.runOperation,
  runGitSignIn: h.runSignIn,
  gitManagerEnvironment: {
    getRefs: h.refsAtom,
    signalWithDegradedFocusRefresh: h.signalAtom,
  },
}));

vi.mock("@legendapp/list/react", () => ({
  LegendList: ({
    data,
    renderItem,
    keyExtractor,
  }: {
    data: ReadonlyArray<unknown>;
    renderItem: (input: { item: unknown; index: number }) => React.ReactNode;
    keyExtractor: (item: unknown) => string;
  }) => (
    <>
      {data.map((item, index) => (
        <div key={keyExtractor(item)}>{renderItem({ item, index })}</div>
      ))}
    </>
  ),
}));

vi.mock("~/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
  PopoverPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("../../state/entities", () => ({
  useProject: () => ({ id: "project-current", title: "sample-docker" }),
}));

vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({
    environmentId: "env-a",
    label: "ai-server",
    displayUrl: "http://ai-server:3773",
  }),
  usePrimaryEnvironmentId: () => "env-primary",
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string } | null) => ({
    data: atom?.kind === "refs" ? h.snapshot : null,
    error: null,
    isPending: false,
    refresh: h.refreshRefs,
    revalidate: h.refreshRefs,
    requiresRetry: false,
  }),
}));

vi.mock("../ui/select", () => ({
  Select: (props: Record<string, unknown>) => {
    h.selectProps = props;
    return <div>{props.children as React.ReactNode}</div>;
  },
  SelectTrigger: (props: Record<string, unknown>) => (
    <button aria-label={props["aria-label"] as string} disabled={props.disabled as boolean}>
      {props.children as React.ReactNode}
    </button>
  ),
  SelectValue: () => <span>Selected worktree</span>,
  SelectPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectGroup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  SelectGroupLabel: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  SelectItem: (props: Record<string, unknown>) => {
    h.itemProps.push(props);
    return <button>{props.children as React.ReactNode}</button>;
  },
}));

vi.mock("../ui/menu", () => ({
  Menu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuTrigger: ({ children, ...props }: Record<string, unknown>) => (
    <button {...props}>{children as React.ReactNode}</button>
  ),
  MenuPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuItem: (props: Record<string, unknown>) => {
    h.menuItemProps.push(props);
    return (
      <button
        aria-label={props["aria-label"] as string | undefined}
        disabled={props.disabled as boolean}
        onClick={props.onClick as React.MouseEventHandler<HTMLButtonElement>}
      >
        {props.children as React.ReactNode}
      </button>
    );
  },
  MenuSeparator: () => <hr />,
  MenuSub: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  MenuSubTrigger: ({ children, ...props }: Record<string, unknown>) => (
    <button disabled={props.disabled as boolean}>{children as React.ReactNode}</button>
  ),
  MenuSubPopup: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("./tags/GitManagerTagDialog", () => ({
  GitManagerTagDialog: (props: Record<string, unknown>) => {
    h.tagDialogProps.push(props);
    return props.open === true ? <div role="dialog">{String(props.action)} tag dialog</div> : null;
  },
}));

vi.mock("./dialogs/GitManagerBranchDialogs", () => ({
  GitManagerBranchDialogs: (props: Record<string, unknown>) => {
    h.branchDialogProps.push(props);
    return props.dialog === null ? null : (
      <div role="dialog">
        {props.errorMessage as React.ReactNode}
        {props.signInPrompt as React.ReactNode}
      </div>
    );
  },
}));

import { GitManagerToolbar } from "./GitManagerToolbar";

const currentProject = { environmentId: "env-a", projectId: "project-current" } as never;
const otherProject = { environmentId: "env-a", projectId: "project-other" } as never;
const worktrees = [
  { path: "/opaque/main", branch: "main", isPrimary: true },
  { path: "/opaque/feature", branch: "feature", isPrimary: false },
] as unknown as ReadonlyArray<VcsWorktreeDescriptor>;

function ref(name: string, overrides: Partial<GitManagerRefEntry> = {}): GitManagerRefEntry {
  return {
    name,
    tipSha: "a".repeat(40),
    upstream: null,
    ahead: 0,
    behind: 0,
    current: false,
    isDefault: false,
    worktreePath: null,
    blocked: [],
    ...overrides,
  };
}

function refsSnapshot(tags: ReadonlyArray<GitManagerRefEntry> = []): GitManagerRefsSnapshot {
  return {
    generation: 1,
    headRef: "main",
    detachedSha: null,
    isDirty: false,
    defaultBranch: "main",
    remotes: ["origin"],
    localBranches: [ref("main", { current: true, isDefault: true, upstream: "origin/main" })],
    remoteBranches: [ref("origin/main")],
    tags,
    worktrees: [],
    inProgressOperation: null,
    conflictedPaths: [],
  };
}

function renderToolbar(
  overrides: Partial<React.ComponentProps<typeof GitManagerToolbar>> = {},
): string {
  return renderToStaticMarkup(
    <GitManagerToolbar
      projectRef={currentProject}
      mainCheckoutCwd="/opaque/main"
      selectedWorktreeCwd="/opaque/main"
      worktrees={worktrees}
      catalogPending={false}
      catalogError={null}
      repositoryUnavailable={null}
      branchSyncDisabledReason={null}
      stashMergeDisabledReason={null}
      tagDisabledReason={null}
      onSelectedWorktreeChange={() => undefined}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  h.selectProps = null;
  h.itemProps.length = 0;
  h.snapshot = null;
  h.refreshRefs.mockClear();
  h.tagDialogProps.length = 0;
  h.branchDialogProps.length = 0;
  h.menuItemProps.length = 0;
  h.refsAtom.mockClear();
  h.signalAtom.mockClear();
  h.runOperation.mockReset();
  h.failureMessage = null;
  h.failures = {};
  h.events = {};
  h.runSignIn.mockReset();
  h.runSignIn.mockImplementation(() => ({
    cancel: vi.fn(),
    result: Promise.resolve({ _tag: "Success", value: { outcome: "signedIn", message: "" } }),
  }));
  h.runOperation.mockImplementation((_registry, { input }, onEvent) => {
    const sequence = h.events[input._tag];
    if (sequence !== undefined) {
      delete h.events[input._tag];
      for (const event of sequence) onEvent(event);
      return {
        cancel: vi.fn(),
        result: Promise.resolve({ _tag: "Success", value: sequence.at(-1) }),
      };
    }
    const failure =
      h.failures[input._tag] ??
      (h.failureMessage === null ? null : { code: "branch-exists", message: h.failureMessage });
    const event: GitManagerOperationEvent =
      failure === null
        ? {
            _tag: "finished",
            operation: input._tag,
            message: "Finished.",
          }
        : {
            _tag: "failed",
            operation: input._tag,
            code: failure.code,
            message: failure.message,
            blocked: null,
          };
    onEvent(event);
    return { cancel: vi.fn(), result: Promise.resolve({ _tag: "Success", value: event }) };
  });
  useGitManagerStore.setState({ byProjectKey: {} });
  // The branch list renders only while its picker is open (#360); these cases click its rows.
  useGitManagerStore.getState().setOpenDropdown(currentProject, "branch");
});

describe("GitManagerToolbar", () => {
  it.each([
    ["origin/develop", true, null, false],
    ["origin/develop", true, "bring", false],
    ["origin/develop", true, "stash", false],
    ["refs/remotes/origin/develop", false, null, false],
    ["origin/develop", true, "bring", true],
  ] as const)(
    "checks out %s (remote: %s, strategy: %s, failure: %s) on its environment",
    async (branchName, isRemote, strategy, fails) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      h.snapshot = {
        ...refsSnapshot(),
        isDirty: strategy !== null,
        localBranches: [...refsSnapshot().localBranches, ...(isRemote ? [] : [ref(branchName)])],
        remoteBranches: [ref("origin/develop")],
      };
      if (fails)
        h.failureMessage =
          "A local branch named 'develop' already exists. Select it in the local branches list.";
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () =>
          root.render(
            <GitManagerToolbar
              projectRef={currentProject}
              mainCheckoutCwd="/opaque/main"
              selectedWorktreeCwd="/opaque/main"
              worktrees={worktrees}
              catalogPending={false}
              catalogError={null}
              repositoryUnavailable={null}
              branchSyncDisabledReason={null}
              stashMergeDisabledReason={null}
              tagDisabledReason={null}
              onSelectedWorktreeChange={() => undefined}
            />,
          ),
        );
        const click = async (text: string) => {
          const button = [...document.querySelectorAll("button")].find(
            (entry) => entry.textContent === text,
          );
          expect(button).toBeDefined();
          await act(async () => button!.click());
        };
        await click(branchName);
        if (strategy !== null) {
          expect(h.runOperation).not.toHaveBeenCalled();
          expect(document.body.textContent).toContain("Switch to origin/develop?");
          await click(strategy === "bring" ? "Bring my changes" : "Leave my changes");
        }
        const targets = h.runOperation.mock.calls.map((call) => call[1]);
        expect(targets.at(-1)).toEqual({
          environmentId: "env-a",
          input: {
            _tag: "branch-checkout",
            cwd: "/opaque/main",
            projectId: "project-current",
            name: `refs/${isRemote ? "remotes" : "heads"}/${branchName}`,
            strategy: strategy === "bring" ? "bring" : null,
          },
        });
        expect(targets.map((target) => target.input._tag)).toEqual(
          strategy === "stash" ? ["stash-push", "branch-checkout"] : ["branch-checkout"],
        );
        if (strategy === "stash") {
          // Leave my changes must save untracked files too, or the switch stays blocked.
          expect(targets[0]?.input).toEqual({
            _tag: "stash-push",
            cwd: "/opaque/main",
            projectId: "project-current",
            message: "WIP before switching to origin/develop",
            paths: [],
            includeUntracked: true,
          });
        }
        expect(h.refreshRefs).toHaveBeenCalled();
        if (fails) {
          expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
            h.failureMessage,
          );
          expect(
            useGitManagerStore.getState().selectViewState(currentProject).selectedRef,
          ).toBeNull();
          h.failureMessage = null;
          await click("Bring my changes");
          expect(document.querySelector('[role="dialog"]')).toBeNull();
        }
        expect(useGitManagerStore.getState().selectViewState(currentProject).selectedRef).toBe(
          isRemote ? "develop" : branchName,
        );
      } finally {
        await act(async () => root.unmount());
        container.remove();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
      }
    },
  );

  it("sends one checkout and one fetch when a branch is chosen and then fetched (#360)", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    h.snapshot = { ...refsSnapshot(), remoteBranches: [ref("origin/develop")] };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const click = async (text: string) => {
      const button = [...document.querySelectorAll("button")].find((entry) =>
        entry.textContent?.includes(text),
      );
      expect(button).toBeDefined();
      await act(async () => button!.click());
    };
    try {
      await act(async () =>
        root.render(
          <GitManagerToolbar
            projectRef={currentProject}
            mainCheckoutCwd="/opaque/main"
            selectedWorktreeCwd="/opaque/main"
            worktrees={worktrees}
            catalogPending={false}
            catalogError={null}
            repositoryUnavailable={null}
            branchSyncDisabledReason={null}
            stashMergeDisabledReason={null}
            tagDisabledReason={null}
            onSelectedWorktreeChange={() => undefined}
          />,
        ),
      );
      await click("origin/develop");
      // Choosing the branch closes the picker; its rows are gone until it opens again.
      expect(
        useGitManagerStore.getState().selectToolbarViewState(currentProject).openDropdown,
      ).toBe(null);
      await click("Fetch origin");

      expect(h.runOperation.mock.calls.map((call) => call[1].input._tag)).toEqual([
        "branch-checkout",
        "fetch",
      ]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it.each([
    [
      "the stash saves nothing",
      "stash-push",
      "nothing-to-stash",
      "Git found no changes it can stash, so nothing was saved.",
      ["stash-push"],
      "Git found no changes it can stash, so nothing was saved.",
    ],
    [
      "changes Git can't stash remain",
      "branch-checkout",
      "dirty-working-tree",
      "Checkout is blocked: the working tree has uncommitted changes.",
      ["stash-push", "branch-checkout"],
      "Your changes are saved in the stash “WIP before switching to origin/develop”, but some changes are still here (Git can't stash changes inside a submodule), so the branch was not switched.",
    ],
    [
      "the switch fails for another reason",
      "branch-checkout",
      "branch-exists",
      "A local branch named 'develop' already exists.",
      ["stash-push", "branch-checkout"],
      "Your changes are saved in the stash “WIP before switching to origin/develop”. A local branch named 'develop' already exists.",
    ],
  ] as const)(
    "keeps Leave my changes open and explains when %s",
    async (_case, failingTag, code, message, expectedTags, expectedAlert) => {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      h.snapshot = { ...refsSnapshot(), isDirty: true, remoteBranches: [ref("origin/develop")] };
      h.failures = { [failingTag]: { code, message } };
      const container = document.createElement("div");
      document.body.append(container);
      const root = createRoot(container);
      try {
        await act(async () =>
          root.render(
            <GitManagerToolbar
              projectRef={currentProject}
              mainCheckoutCwd="/opaque/main"
              selectedWorktreeCwd="/opaque/main"
              worktrees={worktrees}
              catalogPending={false}
              catalogError={null}
              repositoryUnavailable={null}
              branchSyncDisabledReason={null}
              stashMergeDisabledReason={null}
              tagDisabledReason={null}
              onSelectedWorktreeChange={() => undefined}
            />,
          ),
        );
        const click = async (text: string) => {
          const button = [...document.querySelectorAll("button")].find(
            (entry) => entry.textContent === text,
          );
          expect(button).toBeDefined();
          await act(async () => button!.click());
        };
        await click("origin/develop");
        await click("Leave my changes");

        expect(h.runOperation.mock.calls.map((call) => call[1].input._tag)).toEqual(expectedTags);
        expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
          expectedAlert,
        );
        expect(
          useGitManagerStore.getState().selectViewState(currentProject).selectedRef,
        ).toBeNull();
      } finally {
        await act(async () => root.unmount());
        container.remove();
        (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
      }
    },
  );

  it("opens on the current project's main checkout, not another project's cached worktree", () => {
    useGitManagerStore.getState().setSelectedWorktree(otherProject, "/opaque/other-worktree");

    renderToolbar();

    expect(h.selectProps?.value).toBe("/opaque/main");
    expect(h.itemProps.map((props) => props.value)).toEqual(["/opaque/main", "/opaque/feature"]);
  });

  it("names the project it manages ahead of the worktree selector", () => {
    const markup = renderToolbar();

    expect(markup).toContain('data-testid="git-manager-project"');
    expect(markup).toContain("sample-docker");
    expect(markup).toContain('title="/opaque/main"');
    expect(markup).toContain('data-testid="git-manager-environment"');
    expect(markup).toContain("ai-server");
    expect(markup).toContain('title="http://ai-server:3773"');
  });

  it("persists an explicit worktree selection through its callback", () => {
    const onSelectedWorktreeChange = vi.fn();
    renderToolbar({ onSelectedWorktreeChange });

    (h.selectProps?.onValueChange as ((value: string | null) => void) | undefined)?.(
      "/opaque/feature",
    );
    expect(onSelectedWorktreeChange).toHaveBeenCalledWith("/opaque/feature");
  });

  it("renders the branch selector and an accessible sync loading state", () => {
    const markup = renderToolbar();

    expect(markup).toContain('aria-label="Choose branch"');
    expect(markup).toContain("Loading repository state…");
    expect(markup).toContain('title="Loading repository state."');
    expect(markup).toContain('title="Loading tags."');
    expect(markup).toContain('aria-describedby="git-manager-tag-trigger-reason"');
  });

  it("opens create, delete, and push tag dialogs from the toolbar", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    h.snapshot = refsSnapshot([ref("release/v1")]);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () =>
        root.render(
          <GitManagerToolbar
            projectRef={currentProject}
            mainCheckoutCwd="/opaque/main"
            selectedWorktreeCwd="/opaque/main"
            worktrees={worktrees}
            catalogPending={false}
            catalogError={null}
            repositoryUnavailable={null}
            branchSyncDisabledReason={null}
            stashMergeDisabledReason={null}
            tagDisabledReason={null}
            onSelectedWorktreeChange={() => undefined}
          />,
        ),
      );
      const clickAction = async (label: string) => {
        const action = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
        expect(action).not.toBeNull();
        await act(async () => action?.click());
      };

      await clickAction("Create tag");
      expect(container.querySelector('[role="dialog"]')?.textContent).toBe("create tag dialog");
      expect(h.tagDialogProps.at(-1)).toMatchObject({
        action: "create",
        existingTags: ["release/v1"],
        targetSha: "a".repeat(40),
      });

      const closeCreate = h.tagDialogProps.at(-1)?.onOpenChange;
      expect(closeCreate).toBeTypeOf("function");
      await act(async () => (closeCreate as (open: boolean) => void)(false));
      await clickAction("Delete tag release/v1");
      expect(container.querySelector('[role="dialog"]')?.textContent).toBe("delete tag dialog");
      expect(h.tagDialogProps.at(-1)).toMatchObject({ action: "delete", tag: "release/v1" });

      const closeDelete = h.tagDialogProps.at(-1)?.onOpenChange;
      expect(closeDelete).toBeTypeOf("function");
      await act(async () => (closeDelete as (open: boolean) => void)(false));
      await clickAction("Push tag release/v1");
      expect(container.querySelector('[role="dialog"]')?.textContent).toBe("push tag dialog");
      expect(h.tagDialogProps.at(-1)).toMatchObject({
        action: "push",
        remote: "origin",
        tag: "release/v1",
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it("offers remote sources to New Branch and creates without checking out when asked", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    h.snapshot = { ...refsSnapshot([]), remoteBranches: [ref("origin/release")] };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    try {
      await act(async () =>
        root.render(
          <GitManagerToolbar
            projectRef={currentProject}
            mainCheckoutCwd="/opaque/main"
            selectedWorktreeCwd="/opaque/main"
            worktrees={worktrees}
            catalogPending={false}
            catalogError={null}
            repositoryUnavailable={null}
            branchSyncDisabledReason={null}
            stashMergeDisabledReason={null}
            tagDisabledReason={null}
            onSelectedWorktreeChange={() => undefined}
          />,
        ),
      );
      const props = h.branchDialogProps.at(-1)!;
      expect(props.remoteRefs).toEqual([ref("origin/release")]);
      await act(async () =>
        (props.onSubmit as (submission: unknown) => Promise<void>)({
          kind: "create",
          name: "feature/later",
          startPoint: "refs/remotes/origin/release",
          checkout: false,
        }),
      );
      expect(h.runOperation).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          input: expect.objectContaining({
            _tag: "branch-create",
            name: "feature/later",
            startPoint: "refs/remotes/origin/release",
            checkout: false,
          }),
        }),
        expect.any(Function),
      );
    } finally {
      await act(async () => root.unmount());
      container.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it("treats an interrupted clone's placeholder HEAD as a repository without commits", () => {
    h.snapshot = {
      ...refsSnapshot(),
      headRef: null,
      detachedSha: null,
      defaultBranch: null,
      localBranches: [],
      remoteBranches: [],
    };
    const placeholder = renderToolbar();
    expect(placeholder).toContain("No commits yet");
    expect(placeholder).not.toContain("Detached HEAD");
    expect(placeholder).toContain("Fetch origin");
    expect(placeholder).not.toContain("Publish branch");

    h.snapshot = {
      ...refsSnapshot(),
      headRef: null,
      detachedSha: "b".repeat(40),
      localBranches: [ref("main", { isDefault: true })],
    };
    const detached = renderToolbar();
    expect(detached).toContain("Detached HEAD");
    expect(detached).not.toContain("No commits yet");
  });

  it("uses the outer panel's unavailable state ahead of cached branch and sync data", () => {
    h.snapshot = refsSnapshot();
    const reason =
      "Git can't read this repository. Check its .git folder, for example a damaged HEAD or config file.";
    const container = document.createElement("div");
    container.innerHTML = renderToolbar({
      repositoryUnavailable: "unreadable",
      branchSyncDisabledReason: reason,
      stashMergeDisabledReason: reason,
      tagDisabledReason: reason,
    });
    const branch = container.querySelector<HTMLButtonElement>('[aria-label="Choose branch"]');
    expect(branch?.textContent).toBe("No branch");
    expect(branch?.disabled).toBe(true);
    expect(branch?.title).toBe(
      "Git can't read this repository. Check its .git folder, for example a damaged HEAD or config file.",
    );
    expect(container.textContent).toContain("Sync unavailable");
    expect(container.textContent).not.toContain("Detached HEAD");
    expect(container.textContent).not.toContain("Fetch origin");
    expect(container.querySelector<HTMLButtonElement>('[aria-label="Worktree"]')?.disabled).toBe(
      false,
    );
  });

  it("does not advertise local tags as pending pushes without remote tag state", () => {
    h.snapshot = refsSnapshot([ref("already-published")]);

    const markup = renderToolbar();

    expect(markup).toContain("Fetch origin");
    expect(markup).not.toContain('aria-label="1 ahead"');
  });

  it("disables branch sync operations with their reason while tag and worktree controls remain", () => {
    const reason = "This environment does not support Git Manager branch and sync operations.";
    h.snapshot = refsSnapshot([ref("release/v1")]);

    const markup = renderToolbar({ branchSyncDisabledReason: reason });

    expect(markup).toContain(`title="${reason}"`);
    expect(markup).toContain(reason);
    expect(markup).toContain('aria-label="Choose branch"');
    expect(markup).toContain('aria-label="Worktree"');
    expect(markup).toContain("Tags…");
  });

  it("disables tag operations with their reason while branch sync remains available", () => {
    const reason = "This environment does not support Git Manager tag operations.";
    h.snapshot = refsSnapshot([ref("release/v1")]);

    const markup = renderToolbar({ tagDisabledReason: reason });

    expect(markup).toContain(`title="${reason}"`);
    expect(markup).toContain(reason);
    expect(markup).toContain('aria-label="Choose branch"');
    expect(markup).toContain("Fetch origin");
  });

  it("renders tag menu reasons at the smallest app text size", () => {
    const reason = "This environment does not support Git Manager tag operations.";
    h.snapshot = refsSnapshot([ref("release/v1")]);
    const disabled = renderToolbar({ tagDisabledReason: reason });
    h.snapshot = refsSnapshot();
    const empty = renderToolbar();

    for (const markup of [disabled, empty]) expect(markup).not.toMatch(/text-\[\d+px\]/);
    expect(disabled).toContain(`<span class="text-xs text-muted-foreground">${reason}</span>`);
    expect(empty).toContain('<span class="text-xs text-muted-foreground">No local tags.</span>');
  });

  describe("remote branch delete (#397)", () => {
    const offer = {
      remote: "origin",
      destination: "https://gitlab.example.test/example-group/sample-project.git",
      host: "gitlab.example.test",
      direction: "push" as const,
    };
    const resume = {
      _tag: "remote-branch-delete" as const,
      cwd: "/opaque/main",
      projectId: "project-current" as never,
      remote: "origin",
      branch: "develop",
      expectedDestination: offer.destination,
    };
    const signInFailure: GitManagerOperationEvent = {
      _tag: "failed",
      operation: "remote-branch-delete",
      code: "sign-in-required",
      message: "Sign in to continue.",
      blocked: null,
      signIn: { ...offer, resume },
    };
    const wholeDeleteResume = {
      _tag: "branch-delete" as const,
      cwd: "/opaque/main",
      projectId: "project-current" as never,
      name: "develop",
      force: true,
      deleteRemote: true,
      expectedDestination: offer.destination,
    };
    const wholeDeleteSignIn: GitManagerOperationEvent = {
      ...signInFailure,
      operation: "branch-delete",
      signIn: { ...offer, resume: wholeDeleteResume },
    };
    const localWithUpstream = () => ({
      ...refsSnapshot(),
      localBranches: [
        ...refsSnapshot().localBranches,
        ref("develop", { upstream: "origin/develop" }),
      ],
      remoteBranches: [ref("origin/develop")],
    });
    let container: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;

    async function mount() {
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
      await rerender();
    }

    async function rerender() {
      await act(async () =>
        root.render(
          <GitManagerToolbar
            projectRef={currentProject}
            mainCheckoutCwd="/opaque/main"
            selectedWorktreeCwd="/opaque/main"
            worktrees={worktrees}
            catalogPending={false}
            catalogError={null}
            repositoryUnavailable={null}
            branchSyncDisabledReason={null}
            stashMergeDisabledReason={null}
            tagDisabledReason={null}
            onSelectedWorktreeChange={() => undefined}
          />,
        ),
      );
    }

    async function unmount() {
      await act(async () => root.unmount());
      container.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }

    const lastDialogProps = () => h.branchDialogProps.at(-1)!;
    const clickButton = async (text: string) => {
      const button = [...document.querySelectorAll("button")].find(
        (entry) => entry.textContent === text,
      );
      expect(button).toBeDefined();
      await act(async () => button!.click());
    };
    const submit = async (submission: Record<string, unknown>) => {
      const onSubmit = lastDialogProps().onSubmit as (value: unknown) => Promise<void>;
      await act(async () => onSubmit(submission));
    };
    const sentInputs = () => h.runOperation.mock.calls.map((call) => call[1].input);

    it.each([
      ["with a local branch of the same name", true],
      ["for a remote-only branch", false],
    ])("deletes the remote row %s, then the row is gone", async (_, withLocal) => {
      const local = withLocal ? [ref("develop")] : [];
      h.snapshot = {
        ...refsSnapshot(),
        localBranches: [...refsSnapshot().localBranches, ...local],
        remoteBranches: [ref("origin/main", { isDefault: true }), ref("origin/develop")],
      };
      await mount();
      try {
        const deleteButton = container.querySelector<HTMLButtonElement>(
          '[aria-label="Delete remote branch origin/develop"]',
        );
        await act(async () => deleteButton!.click());
        expect(lastDialogProps().dialog).toMatchObject({
          kind: "delete-remote",
          remote: "origin",
          remoteBranch: "develop",
        });

        await submit({ kind: "delete-remote", remote: "origin", branch: "develop" });

        expect(sentInputs()).toEqual([
          {
            _tag: "remote-branch-delete",
            cwd: "/opaque/main",
            projectId: "project-current",
            remote: "origin",
            branch: "develop",
          },
        ]);
        expect(lastDialogProps().dialog).toBeNull();
        expect(h.refreshRefs).toHaveBeenCalled();

        h.snapshot = { ...h.snapshot, remoteBranches: [ref("origin/main", { isDefault: true })] };
        await act(async () =>
          useGitManagerStore.getState().setOpenDropdown(currentProject, "branch"),
        );
        await rerender();
        expect(
          container.querySelector('[aria-label="Delete remote branch origin/develop"]'),
        ).toBeNull();
        expect(container.querySelector('[aria-label="Delete develop"]') !== null).toBe(withLocal);
      } finally {
        await unmount();
      }
    });

    it("offers sign-in inside the dialog and resumes the offer's request unchanged", async () => {
      h.snapshot = { ...refsSnapshot(), remoteBranches: [ref("origin/develop")] };
      h.events = { "remote-branch-delete": [signInFailure] };
      await mount();
      try {
        await act(async () =>
          container
            .querySelector<HTMLButtonElement>('[aria-label="Delete remote branch origin/develop"]')!
            .click(),
        );
        await submit({ kind: "delete-remote", remote: "origin", branch: "develop" });
        expect(lastDialogProps().dialog).not.toBeNull();
        expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
          "gitlab.example.test",
        );

        await clickButton("Sign in");

        expect(h.runSignIn).toHaveBeenCalledTimes(1);
        expect(sentInputs()).toEqual([
          {
            _tag: "remote-branch-delete",
            cwd: "/opaque/main",
            projectId: "project-current",
            remote: "origin",
            branch: "develop",
          },
          resume,
        ]);
        expect(lastDialogProps().dialog).toBeNull();
      } finally {
        await unmount();
      }
    });

    it("keeps the dialog open with the failure when sign-in is declined", async () => {
      h.snapshot = { ...refsSnapshot(), remoteBranches: [ref("origin/develop")] };
      h.events = { "remote-branch-delete": [signInFailure] };
      await mount();
      try {
        await act(async () =>
          container
            .querySelector<HTMLButtonElement>('[aria-label="Delete remote branch origin/develop"]')!
            .click(),
        );
        await submit({ kind: "delete-remote", remote: "origin", branch: "develop" });
        await clickButton("Not now");

        expect(sentInputs()).toHaveLength(1);
        expect(lastDialogProps().dialog).not.toBeNull();
        expect(lastDialogProps().errorMessage).toBe(
          "Authentication failed. Check the configured credentials and try again.",
        );
      } finally {
        await unmount();
      }
    });

    it("ends a pending sign-in when the dialog is cancelled, so nothing resumes", async () => {
      h.snapshot = { ...refsSnapshot(), remoteBranches: [ref("origin/develop")] };
      h.events = { "remote-branch-delete": [signInFailure] };
      await mount();
      try {
        await act(async () =>
          container
            .querySelector<HTMLButtonElement>('[aria-label="Delete remote branch origin/develop"]')!
            .click(),
        );
        await submit({ kind: "delete-remote", remote: "origin", branch: "develop" });
        await act(async () => (lastDialogProps().onClose as () => void)());

        expect(lastDialogProps().dialog).toBeNull();
        expect([...document.querySelectorAll("button")].map((b) => b.textContent)).not.toContain(
          "Sign in",
        );
        expect(h.runSignIn).not.toHaveBeenCalled();
        expect(sentInputs()).toHaveLength(1);
      } finally {
        await unmount();
      }
    });

    it("shows the remote's rejection text and keeps the dialog open", async () => {
      const rejection = " ! [remote rejected] develop (protected branch hook declined)";
      h.snapshot = { ...refsSnapshot(), remoteBranches: [ref("origin/develop")] };
      h.events = {
        "remote-branch-delete": [
          { _tag: "started", operation: "remote-branch-delete" },
          { _tag: "output", operation: "remote-branch-delete", stream: "stderr", text: rejection },
          {
            _tag: "failed",
            operation: "remote-branch-delete",
            code: "git-command-failed",
            message: "The Git command failed.",
            blocked: null,
          },
        ],
      };
      await mount();
      try {
        await act(async () =>
          container
            .querySelector<HTMLButtonElement>('[aria-label="Delete remote branch origin/develop"]')!
            .click(),
        );
        await submit({ kind: "delete-remote", remote: "origin", branch: "develop" });

        expect(lastDialogProps().dialog).not.toBeNull();
        expect(lastDialogProps().errorMessage).toContain("protected branch hook declined");
      } finally {
        await unmount();
      }
    });

    it("keeps local delete with its remote and now offers sign-in for it", async () => {
      h.snapshot = {
        ...refsSnapshot(),
        localBranches: [
          ...refsSnapshot().localBranches,
          ref("develop", { upstream: "origin/develop" }),
        ],
        remoteBranches: [ref("origin/develop")],
      };
      h.events = { "branch-delete": [wholeDeleteSignIn] };
      await mount();
      try {
        await act(async () =>
          container.querySelector<HTMLButtonElement>('[aria-label="Delete develop"]')!.click(),
        );
        expect(lastDialogProps().dialog).toMatchObject({ kind: "delete", existsUpstream: true });
        await submit({ kind: "delete", name: "develop", deleteRemote: true });

        expect(sentInputs()).toEqual([
          {
            _tag: "branch-delete",
            cwd: "/opaque/main",
            projectId: "project-current",
            name: "develop",
            force: true,
            deleteRemote: true,
          },
        ]);
        expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
          "gitlab.example.test",
        );
        await clickButton("Sign in");
        // The server's offer names what resumes: here the whole delete, because its remote check
        // needed the sign-in before anything was deleted. The client sends it unchanged, once.
        expect(sentInputs().slice(1)).toEqual([wholeDeleteResume]);
        expect(lastDialogProps().dialog).toBeNull();
      } finally {
        await unmount();
      }
    });

    it("resumes only the remote delete when the local branch is already gone", async () => {
      const withLocal = {
        ...refsSnapshot(),
        localBranches: [
          ...refsSnapshot().localBranches,
          ref("develop", { upstream: "origin/develop" }),
        ],
        remoteBranches: [ref("origin/develop")],
      };
      h.snapshot = withLocal;
      h.events = { "branch-delete": [{ ...signInFailure, operation: "branch-delete" }] };
      await mount();
      try {
        await act(async () =>
          container.querySelector<HTMLButtonElement>('[aria-label="Delete develop"]')!.click(),
        );
        await submit({ kind: "delete", name: "develop", deleteRemote: true });
        // The push failed after the local delete, so the server offers the remote delete only.
        h.snapshot = { ...withLocal, localBranches: refsSnapshot().localBranches };
        await rerender();
        await clickButton("Sign in");

        expect(sentInputs().slice(1)).toEqual([resume]);
        expect(lastDialogProps().dialog).toBeNull();
      } finally {
        await unmount();
      }
    });

    it("blocks a second submission while a sign-in is pending", async () => {
      h.snapshot = {
        ...refsSnapshot(),
        localBranches: [
          ...refsSnapshot().localBranches,
          ref("develop", { upstream: "origin/develop" }),
        ],
        remoteBranches: [ref("origin/develop")],
      };
      h.events = { "branch-delete": [{ ...signInFailure, operation: "branch-delete" }] };
      await mount();
      try {
        await act(async () =>
          container.querySelector<HTMLButtonElement>('[aria-label="Delete develop"]')!.click(),
        );
        await submit({ kind: "delete", name: "develop", deleteRemote: true });
        expect(lastDialogProps().disabledReason).toBe("Finish or cancel the sign-in first.");
        await submit({ kind: "delete", name: "develop", deleteRemote: false });

        expect(sentInputs()).toHaveLength(1);
        expect(lastDialogProps().dialog).not.toBeNull();
      } finally {
        await unmount();
      }
    });

    const fetchResume = {
      _tag: "fetch" as const,
      cwd: "/opaque/main",
      projectId: "project-current" as never,
      remote: "origin",
      expectedDestination: offer.destination,
    };
    const fetchSignIn: GitManagerOperationEvent = {
      _tag: "failed",
      operation: "fetch",
      code: "sign-in-required",
      message: "Sign in to continue.",
      blocked: null,
      signIn: { ...offer, direction: "fetch", resume: fetchResume },
    };

    // Round 2 (Codex 1, Antigravity 1): a cancelled delete leaves nothing behind that a later,
    // unrelated sign-in could act on.
    it("never deletes a branch after an unrelated sign-in that follows a cancelled delete", async () => {
      h.snapshot = localWithUpstream();
      h.events = { "branch-delete": [wholeDeleteSignIn] };
      await mount();
      try {
        await act(async () =>
          container.querySelector<HTMLButtonElement>('[aria-label="Delete develop"]')!.click(),
        );
        await submit({ kind: "delete", name: "develop", deleteRemote: true });
        await clickButton("Not now");
        await act(async () => (lastDialogProps().onClose as () => void)());

        h.events = { fetch: [fetchSignIn] };
        const fetchButton = [...document.querySelectorAll("button")].find((entry) =>
          entry.textContent?.includes("Fetch origin"),
        );
        await act(async () => fetchButton!.click());
        await clickButton("Sign in");

        expect(sentInputs().map((input) => input._tag)).toEqual([
          "branch-delete",
          "fetch",
          "fetch",
        ]);
        expect(sentInputs().at(-1)).toEqual(fetchResume);
      } finally {
        await unmount();
      }
    });

    // Round 2 (Antigravity 2): a sign-in that resolves just after the dialog closed resumes
    // nothing.
    it("resumes nothing when the sign-in finishes after the dialog was closed", async () => {
      let finish: (value: unknown) => void = () => undefined;
      h.runSignIn.mockImplementation(() => ({
        cancel: vi.fn(),
        result: new Promise((resolve) => {
          finish = resolve;
        }),
      }));
      h.snapshot = { ...refsSnapshot(), remoteBranches: [ref("origin/develop")] };
      h.events = { "remote-branch-delete": [signInFailure] };
      await mount();
      try {
        await act(async () =>
          container
            .querySelector<HTMLButtonElement>('[aria-label="Delete remote branch origin/develop"]')!
            .click(),
        );
        await submit({ kind: "delete-remote", remote: "origin", branch: "develop" });
        await clickButton("Sign in");
        await act(async () => (lastDialogProps().onClose as () => void)());
        // Round 3 (Antigravity 3): the cancelled delete's prompt does not move to the toolbar.
        expect(container.textContent).not.toContain("gitlab.example.test");

        // A newer failure is not overwritten when the cancelled sign-in settles late.
        h.failures = { fetch: { code: "git-command-failed", message: "Fetch failed here." } };
        const fetchButton = [...document.querySelectorAll("button")].find((entry) =>
          entry.textContent?.includes("Fetch origin"),
        );
        await act(async () => fetchButton!.click());
        await act(async () =>
          finish({ _tag: "Success", value: { outcome: "signedIn", message: "" } }),
        );

        expect(sentInputs().map((input) => input._tag)).toEqual(["remote-branch-delete", "fetch"]);
        expect(lastDialogProps().dialog).toBeNull();
        expect(container.textContent).toContain("Fetch failed here.");
        expect(container.textContent).not.toContain("cancelled");
      } finally {
        await unmount();
      }
    });

    // The same race through unmount: the panel closing never resumes a delete afterwards.
    it("resumes nothing when the sign-in finishes after the toolbar unmounted", async () => {
      let finish: (value: unknown) => void = () => undefined;
      h.runSignIn.mockImplementation(() => ({
        cancel: vi.fn(),
        result: new Promise((resolve) => {
          finish = resolve;
        }),
      }));
      h.snapshot = { ...refsSnapshot(), remoteBranches: [ref("origin/develop")] };
      h.events = { "remote-branch-delete": [signInFailure] };
      await mount();
      await act(async () =>
        container
          .querySelector<HTMLButtonElement>('[aria-label="Delete remote branch origin/develop"]')!
          .click(),
      );
      await submit({ kind: "delete-remote", remote: "origin", branch: "develop" });
      await clickButton("Sign in");
      await unmount();
      await act(async () =>
        finish({ _tag: "Success", value: { outcome: "signedIn", message: "" } }),
      );

      expect(sentInputs()).toHaveLength(1);
    });

    // Round 2 (Antigravity 7): a branch dialog opened while a sync sign-in waits shows that
    // prompt, and closing the dialog leaves the sign-in for the toolbar.
    it("keeps a pending sync sign-in reachable from New Branch and never ends it on close", async () => {
      h.snapshot = refsSnapshot();
      h.events = { fetch: [fetchSignIn] };
      await mount();
      try {
        const fetchButton = [...document.querySelectorAll("button")].find((entry) =>
          entry.textContent?.includes("Fetch origin"),
        );
        await act(async () => fetchButton!.click());
        const newBranch = [...document.querySelectorAll("button")].find((entry) =>
          entry.textContent?.includes("New branch"),
        );
        await act(async () => newBranch!.click());
        expect(lastDialogProps().dialog).toMatchObject({ kind: "create" });
        expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
          "gitlab.example.test",
        );

        await act(async () => (lastDialogProps().onClose as () => void)());
        expect(lastDialogProps().dialog).toBeNull();
        await clickButton("Sign in");

        expect(sentInputs().at(-1)).toEqual(fetchResume);
      } finally {
        await unmount();
      }
    });
  });

  it("skips the live signal subscription without disabling explicit repository reads", () => {
    h.snapshot = refsSnapshot();

    const markup = renderToolbar();

    expect(h.signalAtom).not.toHaveBeenCalled();
    expect(h.refsAtom).toHaveBeenCalledOnce();
    expect(markup).toContain('aria-label="Choose branch"');
    expect(markup).toContain("Fetch origin");
  });
});
