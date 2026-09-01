import type { VcsWorktreeDescriptor } from "@bibcode/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { useGitManagerStore } from "../../gitManagerStore";

const h = vi.hoisted(() => ({
  selectProps: null as Record<string, unknown> | null,
  itemProps: [] as Array<Record<string, unknown>>,
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

import { GitManagerToolbar } from "./GitManagerToolbar";

const currentProject = { environmentId: "env-a", projectId: "project-current" } as never;
const otherProject = { environmentId: "env-a", projectId: "project-other" } as never;
const worktrees = [
  { path: "/opaque/main", branch: "main", isPrimary: true },
  { path: "/opaque/feature", branch: "feature", isPrimary: false },
] as unknown as ReadonlyArray<VcsWorktreeDescriptor>;

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
    expect(markup.match(/disabled=""/g)).toHaveLength(1);
  });
});
