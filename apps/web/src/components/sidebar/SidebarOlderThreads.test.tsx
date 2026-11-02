// @vitest-environment happy-dom
import { EnvironmentId, ProjectId } from "@bibcode/contracts";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const h = vi.hoisted(() => ({
  status: "live",
  state: {
    generation: 0,
    threads: new Map<string, { id: string; title: string }>(),
    missing: new Set<string>(),
    pages: new Map<string, { threadIds: string[]; cursor: string | null }>(),
  },
  outcome: null as null | ((value: "loaded" | "failed") => void),
  loads: [] as Array<{ append: boolean }>,
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({ status: h.status }) }));
vi.mock("../../state/shell", () => ({ environmentShell: { stateValueAtom: () => "shell" } }));
vi.mock("../../state/offShell", () => ({
  olderPageKey: () => "page",
  useOffShellState: () => h.state,
  loadOlderThreads: (_environmentId: unknown, _scope: unknown, options: { append: boolean }) => {
    h.loads.push(options);
    return new Promise((resolve) => {
      h.outcome = resolve;
    });
  },
}));
vi.mock("../ui/sidebar", () => ({
  SidebarMenuSubItem: (props: { children: ReactNode }) => <li>{props.children}</li>,
  SidebarMenuSubButton: ({
    render,
    children,
    size: _size,
    ...rest
  }: {
    render: ReactElement;
    children: ReactNode;
    size?: string;
  }) => cloneElement(render, rest, children),
}));

import { SidebarOlderThreads } from "./SidebarOlderThreads";

let container: HTMLDivElement;
let root: Root;

function mount(count = 12): void {
  act(() => {
    root.render(
      <SidebarOlderThreads
        environmentId={EnvironmentId.make("environment-1")}
        projectId={ProjectId.make("project-1")}
        projectName="Web"
        count={count}
        onOpenThread={() => undefined}
      />,
    );
  });
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name || candidate.getAttribute("aria-label") === name,
  );
  if (found === undefined) throw new Error(`no button ${name}: ${container.innerHTML}`);
  return found;
}

async function finish(outcome: "loaded" | "failed"): Promise<void> {
  await act(async () => {
    h.outcome?.(outcome);
    await Promise.resolve();
  });
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  h.status = "live";
  h.state = { generation: 0, threads: new Map(), missing: new Set(), pages: new Map() };
  h.loads = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("SidebarOlderThreads (#223)", () => {
  it("names its count and project, and loads the first page while showing that it loads", async () => {
    mount();
    const row = button("12 older threads in Web");
    expect(row.textContent).toBe("12 older threads");
    act(() => row.click());
    expect(h.loads).toEqual([{ append: false }]);
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Loading older threads…");
    h.state = {
      ...h.state,
      threads: new Map([["t1", { id: "t1", title: "Older fix" }]]),
      pages: new Map([["page", { threadIds: ["t1"], cursor: "next" }]]),
    };
    await finish("loaded");
    expect(button("Older fix")).toBeDefined();
    act(() => button("Load 20 more").click());
    expect(h.loads.at(-1)).toEqual({ append: true });
  });

  it("offers a retry in place when a page fails, keeping what loaded", async () => {
    mount();
    act(() => button("12 older threads in Web").click());
    await finish("failed");
    expect(container.textContent).toContain("Couldn't load older threads.");
    act(() => button("Retry").click());
    expect(h.loads).toHaveLength(2);
  });

  it("is disabled offline and says why", () => {
    h.status = "degraded";
    mount();
    const row = button("12 older threads in Web");
    expect(row.disabled).toBe(true);
    expect(row.textContent).toBe("12 older threads: reconnect to load");
    expect(row.getAttribute("aria-description")).toBe("Reconnect to load older threads.");
  });

  it("removes itself when a page comes back empty", async () => {
    mount(3);
    act(() => button("3 older threads in Web").click());
    h.state = { ...h.state, pages: new Map([["page", { threadIds: [], cursor: null }]]) };
    await finish("loaded");
    expect(container.textContent).toBe("");
  });

  it("shows nothing when nothing was left out", () => {
    mount(0);
    expect(container.textContent).toBe("");
  });
});
