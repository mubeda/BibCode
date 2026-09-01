// @vitest-environment happy-dom

import type {
  GitManagerRefEntry,
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
}));

vi.mock("../../state/gitManager", () => ({
  gitManagerEnvironment: {
    getRefs: vi.fn(() => ({ kind: "refs" })),
    signal: vi.fn(() => ({ kind: "signal" })),
  },
}));

vi.mock("../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string }) => ({
    data: atom.kind === "refs" ? h.snapshot : null,
    error: null,
    isPending: false,
    refresh: h.refreshRefs,
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

vi.mock("./tags/GitManagerTagDialog", () => ({
  GitManagerTagDialog: (props: Record<string, unknown>) => {
    h.tagDialogProps.push(props);
    return props.open === true ? <div role="dialog">Create tag dialog</div> : null;
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
  useGitManagerStore.setState({ byProjectKey: {} });
});

describe("GitManagerToolbar", () => {
  it("opens on the current project's main checkout, not another project's cached worktree", () => {
    useGitManagerStore.getState().setSelectedWorktree(otherProject, "/opaque/other-worktree");

    renderToolbar();

    expect(h.selectProps?.value).toBe("/opaque/main");
    expect(h.itemProps.map((props) => props.value)).toEqual(["/opaque/main", "/opaque/feature"]);
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
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });

  it("opens the create-tag dialog from the toolbar at the current commit", async () => {
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
            onSelectedWorktreeChange={() => undefined}
          />,
        ),
      );
      const trigger = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
        button.textContent?.includes("Create tag"),
      );
      expect(trigger).toBeDefined();

      await act(async () => trigger?.click());

      expect(container.querySelector('[role="dialog"]')?.textContent).toBe("Create tag dialog");
      expect(h.tagDialogProps.at(-1)).toMatchObject({
        action: "create",
        existingTags: ["release/v1"],
        targetSha: "a".repeat(40),
      });
    } finally {
      await act(async () => root.unmount());
      container.remove();
      (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it("does not advertise local tags as pending pushes without remote tag state", () => {
    h.snapshot = refsSnapshot([ref("already-published")]);

    const markup = renderToolbar();

    expect(markup).toContain("Fetch origin");
    expect(markup).not.toContain('aria-label="1 ahead"');
  });
});
