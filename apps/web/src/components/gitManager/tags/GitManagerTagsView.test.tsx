// @vitest-environment happy-dom

import type { GitManagerRefEntry, GitManagerRemoteTags } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  remoteTags: null as GitManagerRemoteTags | null,
  pending: false,
  error: null as string | null,
  refresh: vi.fn(),
  getRemoteTags: vi.fn((input: unknown) => ({ kind: "remote-tags", input })),
}));

vi.mock("../../../state/gitManager", () => ({
  gitManagerEnvironment: { getRemoteTags: h.getRemoteTags },
}));

vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: h.remoteTags,
    emission: { _tag: h.remoteTags === null ? "Initial" : "Success" },
    error: h.error,
    isPending: h.pending,
    refresh: h.refresh,
  }),
}));

vi.mock("~/components/ui/collapsible", () => ({
  Collapsible: ({
    children,
    open,
    onOpenChange,
  }: {
    children: React.ReactNode;
    open: boolean;
    onOpenChange: (open: boolean) => void;
  }) => (
    <div data-open={open} data-testid="collapsible">
      <button type="button" onClick={() => onOpenChange(!open)}>
        toggle
      </button>
      {children}
    </div>
  ),
  CollapsibleTrigger: ({ children, ...props }: Record<string, unknown>) => (
    <span aria-label={props["aria-label"] as string | undefined}>
      {children as React.ReactNode}
    </span>
  ),
  CollapsiblePanel: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

import { GitManagerTagsView } from "./GitManagerTagsView";
import { expectLoadingModel } from "~/components/ui/loading-state.testing";

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function tag(name: string, tipSha: string): GitManagerRefEntry {
  return {
    name,
    tipSha,
    upstream: null,
    ahead: 0,
    behind: 0,
    current: false,
    isDefault: false,
    worktreePath: null,
    blocked: [],
  };
}

let container: HTMLDivElement;
let root: Root | null;
const onSectionCollapsedChange = vi.fn();
const onTagAction = vi.fn();

async function renderView(
  overrides: Partial<React.ComponentProps<typeof GitManagerTagsView>> = {},
) {
  await act(async () =>
    root?.render(
      <GitManagerTagsView
        collapsedSections={[]}
        remotes={["origin"]}
        scope={{ environmentId: "env-a" as never, cwd: "/repo" }}
        tagDisabledReason={null}
        tags={[tag("v1", SHA_A), tag("v2", SHA_B)]}
        onSectionCollapsedChange={onSectionCollapsedChange}
        onTagAction={onTagAction}
        {...overrides}
      />,
    ),
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  h.remoteTags = null;
  h.pending = false;
  h.error = null;
  h.refresh.mockClear();
  h.getRemoteTags.mockClear();
  onSectionCollapsedChange.mockClear();
  onTagAction.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  container.remove();
});

describe("GitManagerTagsView", () => {
  it("lists local tags newest first with push and delete actions", async () => {
    await renderView();
    const names = [...container.querySelectorAll('[data-testid^="git-manager-local-tag-"]')].map(
      (row) => row.getAttribute("data-testid"),
    );
    expect(names).toEqual(["git-manager-local-tag-v2", "git-manager-local-tag-v1"]);
    container.querySelector<HTMLButtonElement>('[aria-label="Push tag v2"]')!.click();
    container.querySelector<HTMLButtonElement>('[aria-label="Delete tag v1"]')!.click();
    expect(onTagAction.mock.calls).toEqual([
      ["push", "v2"],
      ["delete", "v1"],
    ]);
  });

  it("queries each remote for its tags and marks presence against local tags", async () => {
    h.remoteTags = {
      remote: "origin",
      status: "available",
      reason: null,
      tags: [
        { name: "v1", targetSha: SHA_A },
        { name: "v3", targetSha: SHA_B },
      ],
    };
    await renderView();
    expect(h.getRemoteTags).toHaveBeenCalledWith({
      environmentId: "env-a",
      input: { cwd: "/repo", remote: "origin" },
    });
    expect(
      container
        .querySelector('[data-testid="git-manager-remote-tag-origin-v3"]')
        ?.getAttribute("data-presence"),
    ).toBe("not-fetched");
    expect(
      container
        .querySelector('[data-testid="git-manager-remote-tag-origin-v1"]')
        ?.getAttribute("data-presence"),
    ).toBe("same");
    expect(container.textContent).toContain("not fetched");
    container.querySelector<HTMLButtonElement>('[aria-label="Refresh tags from origin"]')!.click();
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it("reports an unavailable remote with its reason and a retry", async () => {
    h.remoteTags = { remote: "origin", status: "unavailable", reason: "no route", tags: [] };
    await renderView();
    expect(container.textContent).toContain("no route");
    const retry = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    retry!.click();
    expect(h.refresh).toHaveBeenCalledOnce();
  });

  it("reflects collapsed sections and reports toggles by section key", async () => {
    await renderView({ collapsedSections: ["remote:origin"] });
    const sections = [...container.querySelectorAll('[data-testid="collapsible"]')];
    expect(sections.map((section) => section.getAttribute("data-open"))).toEqual(["true", "false"]);
    sections[0]!.querySelector("button")!.click();
    expect(onSectionCollapsedChange).toHaveBeenCalledWith("local", true);
  });

  it("shows a loading state, not empty-tag copy, while the refs snapshot is pending", async () => {
    await renderView({ refsPending: true, tags: [], remotes: [] });
    expectLoadingModel(container, ["Loading tags…"]);
    expect(container.textContent).not.toContain("No local tags");
    expect(container.textContent).not.toContain("No remote configured");
    expect(h.getRemoteTags).not.toHaveBeenCalled();
  });

  it("says a failed first refs read failed, offers Retry, and lists no tags or remotes", async () => {
    const onRetryRefs = vi.fn();
    await renderView({
      refsLoaded: false,
      refsError: "Could not read refs.",
      onRetryRefs,
      tags: [],
      remotes: [],
    });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not read refs.",
    );
    expect(container.textContent).not.toContain("No local tags");
    expect(container.textContent).not.toContain("No remote configured");
    await act(async () => container.querySelector("button")!.click());
    expect(onRetryRefs).toHaveBeenCalledOnce();
  });

  it("keeps the last tags beside a refresh label while the refs reread", async () => {
    await renderView({ refsRefreshing: true });
    // Two reads, each named once: the refs reread and the remote's first listing.
    expectLoadingModel(container, ["Refreshing tags…", "Loading tags from origin…"]);
    expect(container.querySelector('[data-testid="git-manager-local-tag-v1"]')).not.toBeNull();
  });

  it("shows refresh feedback for a remote that has no tags", async () => {
    h.remoteTags = { remote: "origin", status: "available", reason: null, tags: [] };
    await renderView();
    expect(container.textContent).toContain("No tags on origin.");
    expect(container.querySelector('[role="status"]')).toBeNull();
    h.pending = true;
    await renderView();
    expectLoadingModel(container, ["Refreshing tags from origin…"]);
  });

  it("keeps a disabled tag action's reason on a wrapper that still receives hover", async () => {
    await renderView({ tagDisabledReason: "Tag actions need a newer server." });
    const del = container.querySelector<HTMLButtonElement>('[aria-label="Delete tag v1"]');
    expect(del?.disabled).toBe(true);
    expect(del?.parentElement?.title).toBe("Tag actions need a newer server.");
    const push = container.querySelector<HTMLButtonElement>('[aria-label="Push tag v1"]');
    expect(push?.parentElement?.title).toBe("Tag actions need a newer server.");
    // Assistive technology reads the same reason as the button's description.
    for (const button of [del, push]) {
      const id = button?.getAttribute("aria-describedby") ?? "";
      expect(document.getElementById(id)?.textContent).toBe("Tag actions need a newer server.");
    }
  });

  it("stops the remote refresh icon spinning under reduced motion", async () => {
    h.pending = true;
    await renderView();
    const icon = container.querySelector('[aria-label="Refresh tags from origin"] svg');
    expect(icon?.getAttribute("class")).toContain("motion-safe:animate-spin");
    expect(icon?.getAttribute("class")).not.toMatch(/(^|\s)animate-spin/);
  });

  it("explains the absence of remotes and hides push actions", async () => {
    await renderView({ remotes: [] });
    expect(container.textContent).toContain("No remote configured");
    expect(container.querySelector('[aria-label="Push tag v2"]')).toBeNull();
  });
});
