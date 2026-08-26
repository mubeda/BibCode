// @vitest-environment happy-dom

import { scopedThreadKey, scopeThreadRef } from "@bibcode/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@bibcode/contracts";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { EnvironmentTreeProjection, EnvironmentTreeRow } from "../environmentTree";

const treeCapture = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));

vi.mock("./sidebar/EnvironmentTree", () => ({
  EnvironmentTree: (props: Record<string, unknown>) => {
    treeCapture.props = props;
    return <div role="tree" aria-label="Environments, projects, and threads" />;
  },
}));

vi.mock("./ui/sidebar", async (importOriginal) => {
  const original = await importOriginal<typeof import("./ui/sidebar")>();
  return {
    ...original,
    SidebarContent: ({ children }: { readonly children?: ReactNode }) => <main>{children}</main>,
    SidebarGroup: ({ children }: { readonly children?: ReactNode }) => (
      <section>{children}</section>
    ),
  };
});

import {
  SidebarBrandContent,
  SidebarEnvironmentTreeContent,
  handleSidebarNavigationKeyDown,
  handleSidebarSelectionMouseDown,
} from "./Sidebar";

const ENVIRONMENT = EnvironmentId.make("environment-primary");
const FIRST = ThreadId.make("thread-first");
const SECOND = ThreadId.make("thread-second");

const rows: readonly EnvironmentTreeRow[] = [
  {
    kind: "environment",
    key: `environment:${ENVIRONMENT}`,
    parentKey: null,
    environmentId: ENVIRONMENT,
    environmentKind: "primary",
    status: "online",
    statusText: "Online",
    canonicalLabel: "This Mac",
    lastSynchronizedAt: null,
    level: 1,
    label: "This Mac",
    secondaryLabel: null,
    activityLabel: null,
    isExpanded: true,
    isSelected: false,
    isCached: false,
    isStale: false,
    ariaPosInSet: 1,
    ariaSetSize: 1,
  },
];

const projection: EnvironmentTreeProjection = {
  rows,
  rowByKey: new Map(rows.map((row) => [row.key, row])),
  indexByKey: new Map(rows.map((row, index) => [row.key, index])),
  parentByKey: new Map(rows.map((row) => [row.key, row.parentKey])),
  environmentOrder: [ENVIRONMENT],
  environmentOrderChanged: false,
};

const mounted: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = [];

afterEach(async () => {
  await act(async () => {
    for (const entry of mounted.splice(0)) entry.root.unmount();
  });
  treeCapture.props = null;
  vi.unstubAllGlobals();
});

describe("Sidebar navigation shell", () => {
  it("renders only search, add-project, and the environment tree in left content", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    mounted.push({ root, container });
    const onSearchQueryChange = vi.fn();
    const onOpenAddProject = vi.fn();
    const onToggle = vi.fn();
    const onSelect = vi.fn();
    const onContextMenu = vi.fn();

    await act(async () => {
      root.render(
        <SidebarEnvironmentTreeContent
          projection={projection}
          searchQuery="api"
          pinnedThreadKeys={[]}
          unreadThreadKeys={[]}
          onSearchQueryChange={onSearchQueryChange}
          onOpenAddProject={onOpenAddProject}
          onToggle={onToggle}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />,
      );
    });

    const search = container.querySelector<HTMLInputElement>(
      'input[aria-label="Search environments, projects, and threads"]',
    );
    const addProject = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Add project"]',
    );
    expect(search?.value).toBe("api");
    expect(addProject).not.toBeNull();
    expect(container.querySelectorAll('[role="tree"]')).toHaveLength(1);
    expect(container.textContent).not.toMatch(/diagnostics|availability|group projects|panel/i);
    expect(treeCapture.props).toMatchObject({
      projection,
      pinnedThreadKeys: [],
      unreadThreadKeys: [],
      onToggle,
      onSelect,
      onContextMenu,
    });

    await act(async () => {
      addProject?.click();
      search?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(onOpenAddProject).toHaveBeenCalledOnce();
  });

  it("renders the product brand without manufacturing a stage label", () => {
    const markup = renderToStaticMarkup(
      <SidebarBrandContent appBaseName="BiBCode" stageLabel="Dev" />,
    );
    expect(markup).toContain("BiBCode");
    expect(markup).toContain("Dev");
    expect(
      renderToStaticMarkup(<SidebarBrandContent appBaseName="BiBCode" stageLabel={null} />),
    ).not.toContain("sidebar-brand-stage");
  });
});

describe("Sidebar global event guards", () => {
  function navigationEvent(overrides: { defaultPrevented?: boolean; repeat?: boolean } = {}) {
    return {
      defaultPrevented: overrides.defaultPrevented ?? false,
      repeat: overrides.repeat ?? false,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
  }

  const firstKey = scopedThreadKey(scopeThreadRef(ENVIRONMENT, FIRST));
  const secondKey = scopedThreadKey(scopeThreadRef(ENVIRONMENT, SECOND));
  const first = { environmentId: ENVIRONMENT, id: FIRST } as never;
  const second = { environmentId: ENVIRONMENT, id: SECOND } as never;

  it("handles traversal and numbered jumps across every shortcut guard", () => {
    const navigateToThread = vi.fn();
    const base = {
      orderedThreadKeys: [firstKey, secondKey],
      currentThreadKey: firstKey,
      jumpThreadKeys: [secondKey],
      threadByKey: new Map([
        [firstKey, first],
        [secondKey, second],
      ]),
      navigateToThread,
    };

    expect(
      handleSidebarNavigationKeyDown({
        ...base,
        event: navigationEvent({ defaultPrevented: true }),
        resolveCommand: () => "thread.next",
      }),
    ).toBe(false);
    expect(
      handleSidebarNavigationKeyDown({
        ...base,
        event: navigationEvent({ repeat: true }),
        resolveCommand: () => "thread.next",
      }),
    ).toBe(false);
    expect(
      handleSidebarNavigationKeyDown({
        ...base,
        event: navigationEvent(),
        resolveCommand: () => null,
      }),
    ).toBe(false);

    const traversalEvent = navigationEvent();
    expect(
      handleSidebarNavigationKeyDown({
        ...base,
        event: traversalEvent,
        resolveCommand: () => "thread.next",
      }),
    ).toBe(true);
    expect(traversalEvent.preventDefault).toHaveBeenCalledOnce();
    expect(navigateToThread).toHaveBeenLastCalledWith(scopeThreadRef(ENVIRONMENT, SECOND));

    const jumpEvent = navigationEvent();
    expect(
      handleSidebarNavigationKeyDown({
        ...base,
        event: jumpEvent,
        resolveCommand: () => "thread.jump.1",
      }),
    ).toBe(true);
    expect(jumpEvent.stopPropagation).toHaveBeenCalledOnce();

    expect(
      handleSidebarNavigationKeyDown({
        ...base,
        event: navigationEvent(),
        currentThreadKey: secondKey,
        resolveCommand: () => "thread.next",
      }),
    ).toBe(false);
    expect(
      handleSidebarNavigationKeyDown({
        ...base,
        event: navigationEvent(),
        jumpThreadKeys: ["missing"],
        resolveCommand: () => "thread.jump.1",
      }),
    ).toBe(false);
  });

  it("clears selection only for mouse targets outside safe controls", () => {
    class FakeHtmlElement {
      constructor(private readonly safe: boolean) {}
      closest(): FakeHtmlElement | null {
        return this.safe ? this : null;
      }
    }
    vi.stubGlobal("HTMLElement", FakeHtmlElement);
    const clearSelection = vi.fn();

    expect(
      handleSidebarSelectionMouseDown({ hasSelection: false, target: null, clearSelection }),
    ).toBe(false);
    expect(
      handleSidebarSelectionMouseDown({
        hasSelection: true,
        target: new FakeHtmlElement(true) as never,
        clearSelection,
      }),
    ).toBe(false);
    expect(
      handleSidebarSelectionMouseDown({
        hasSelection: true,
        target: new FakeHtmlElement(false) as never,
        clearSelection,
      }),
    ).toBe(true);
    expect(clearSelection).toHaveBeenCalledOnce();
  });
});
