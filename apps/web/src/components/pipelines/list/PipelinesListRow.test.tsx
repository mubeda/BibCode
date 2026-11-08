// @vitest-environment happy-dom
import { EnvironmentId } from "@bibcode/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  HOVER_PREFETCH_MS,
  prefetchedWithin,
  resetPrefetchGates,
} from "../../pullRequests/hoverPrefetch.logic";
import { pipelineRow } from "../testFixtures";

const h = vi.hoisted(() => ({
  settled: false,
  get: vi.fn((args: unknown) => ({ kind: "get", args })),
}));
vi.mock("../../../state/pipelines", () => ({
  pipelinesEnvironment: {
    get: h.get,
    runAction: { label: "environment-data:pipelines:run-action" },
  },
}));
vi.mock("../../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../pullRequests/shared/usePullRequestsQuery", () => ({
  usePullRequestsQuery: (atom: { kind: string } | null) => ({
    data: h.settled && atom ? { kind: atom.kind } : null,
    error: null,
    isPending: !h.settled && atom !== null,
    emission: { _tag: "Initial" },
  }),
}));
vi.mock("../../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    params,
    children,
    className,
  }: {
    to: string;
    params: Record<string, string>;
    children: React.ReactNode;
    className?: string;
  }) => (
    <a
      className={className}
      href={Object.entries(params).reduce(
        (path, [name, value]) => path.replace(`$${name}`, value),
        to,
      )}
    >
      {children}
    </a>
  ),
}));

import { PipelineActions } from "../actions/PipelineActions";
import { PipelinesListRow } from "./PipelinesListRow";

const scope = { environmentId: EnvironmentId.make("env"), cwd: "/repo" };
const projectRef = { environmentId: "env", projectId: "p" } as never;
let root: Root;
let node: HTMLDivElement;

function renderRows(ids: readonly number[]) {
  act(() =>
    root.render(
      <PipelineActions.Provider scope={scope} provider="gitlab" revision={1} onSettled={vi.fn()}>
        {ids.map((id) => (
          <PipelinesListRow
            key={id}
            row={{ ...pipelineRow, id, label: `#${id}` }}
            provider="gitlab"
            scope={scope}
            projectRef={projectRef}
            mutationsDisabledReason={null}
            repositoryPermission="write"
          />
        ))}
      </PipelineActions.Provider>,
    ),
  );
}
function hover(id: number) {
  const row = node.querySelector(`[aria-label^="#${id} "]`)!;
  act(() => row.dispatchEvent(new PointerEvent("pointerover", { bubbles: true })));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  resetPrefetchGates();
  h.settled = false;
  h.get.mockClear();
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(() => {
  act(() => root.unmount());
  node.remove();
  vi.useRealTimers();
});

describe("PipelinesListRow navigation", () => {
  it("opens the pipeline in BiBCode from anywhere on the row, with actions as their own stops", () => {
    renderRows([4821]);
    const row = node.querySelector('[role="row"][aria-label]')!;
    const title = [...row.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Fix connection recovery",
    )!;
    expect(title.getAttribute("href")).toBe("/project/env/p/pipelines/4821");
    // The title's hit area covers the row; the actions sit above it.
    expect(row.className).toContain("relative");
    expect(title.className).toContain("after:absolute");
    expect(title.className).toContain("after:inset-0");
    const retry = row.querySelector('[aria-label="Retry pipeline #4821"]')!;
    expect(retry.closest(".relative.z-10")).not.toBeNull();
    expect(row.querySelector('[aria-label="More actions for pipeline #4821"]')).not.toBeNull();
  });
});

describe("PipelinesListRow hover prefetch", () => {
  it("reads the pipeline's detail after a 150 ms hover", () => {
    renderRows([4821]);
    hover(4821);
    act(() => vi.advanceTimersByTime(HOVER_PREFETCH_MS - 1));
    expect(h.get).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(h.get).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env",
      input: { cwd: "/repo", pipelineId: 4821, attempt: null, refresh: "user" },
    });
  });

  it("keeps at most two prefetches in flight per environment", () => {
    renderRows([1, 2, 3]);
    hover(1);
    hover(2);
    hover(3);
    act(() => vi.advanceTimersByTime(HOVER_PREFETCH_MS));
    expect(h.get).toHaveBeenCalledTimes(2);
    // An answered prefetch frees its place and is remembered for an open within 5 s.
    h.settled = true;
    renderRows([1, 2, 3]);
    expect(
      prefetchedWithin(
        "pipelines.get",
        {
          environmentId: scope.environmentId,
          input: { cwd: "/repo", pipelineId: 1, attempt: null, refresh: "user" },
        },
        Date.now(),
      ),
    ).toBe(true);
    hover(3);
    act(() => vi.advanceTimersByTime(HOVER_PREFETCH_MS));
    expect(h.get).toHaveBeenCalledTimes(3);
  });
});

describe("PipelinesListRow columns", () => {
  function renderRow(row: typeof pipelineRow) {
    act(() =>
      root.render(
        <PipelineActions.Provider scope={scope} provider="gitlab" revision={1} onSettled={vi.fn()}>
          <PipelinesListRow
            row={row}
            provider="gitlab"
            scope={scope}
            projectRef={projectRef}
            mutationsDisabledReason={null}
            repositoryPermission="write"
          />
        </PipelineActions.Provider>,
      ),
    );
    return node.querySelector<HTMLElement>('[role="row"]')!;
  }

  it("gives a row with Retry, a row with Cancel and a row with neither the same template and cells", () => {
    const shapes = [
      pipelineRow, // failed: Retry
      { ...pipelineRow, status: "running" as const, terminal: false }, // Cancel
      { ...pipelineRow, status: "success" as const, url: null }, // no buttons at all
    ].map((row) => {
      const element = renderRow(row);
      const cells = [...element.querySelectorAll(':scope > [role="cell"]')];
      return { className: element.className, cells: cells.length, last: cells.at(-1)!.className };
    });
    expect(new Set(shapes.map((shape) => shape.className)).size).toBe(1);
    expect(new Set(shapes.map((shape) => shape.cells)).size).toBe(1);
    // The last cell is the Actions track whatever it holds.
    expect(new Set(shapes.map((shape) => shape.last)).size).toBe(1);
    expect(shapes[0]!.className).toContain("grid-cols-(--pipelines-grid-narrow)");
    expect(shapes[0]!.className).toContain("@min-[1100px]:grid-cols-(--pipelines-grid-full)");
  });

  describe("stage overflow", () => {
    const stages = ["build", "lint", "test", "package", "deploy", "verify"].map((name) => ({
      name,
      status: "success" as const,
      warnings: false,
    }));
    let width = 0;
    beforeEach(() => {
      Object.defineProperty(HTMLElement.prototype, "clientWidth", {
        configurable: true,
        get: () => width,
      });
    });
    afterEach(() => {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth;
    });

    it("counts the stages that do not fit and keeps each one readable for assistive technology", () => {
      width = 64;
      const row = renderRow({ ...pipelineRow, stages });
      const list = row.querySelector('ol[aria-label="Stages"]')!;
      const items = [...list.querySelectorAll("li[aria-label]")];
      expect(items.map((item) => item.getAttribute("aria-label"))).toEqual(
        stages.map((stage) => `${stage.name}: passed`),
      );
      expect(items.filter((item) => item.className.includes("sr-only")).length).toBe(4);
      const count = list.querySelector('li[aria-hidden="true"]')!;
      expect(count.textContent).toBe("+4");
      expect(count.getAttribute("title")).toBe(
        "test: passed\npackage: passed\ndeploy: passed\nverify: passed",
      );
    });

    it("shows every stage and no count when they fit or the width is unknown", () => {
      width = 160;
      let row = renderRow({ ...pipelineRow, stages });
      expect(row.querySelector('li[aria-hidden="true"]')).toBeNull();
      width = 0;
      row = renderRow({ ...pipelineRow, stages });
      expect(row.querySelector('li[aria-hidden="true"]')).toBeNull();
    });
  });
});
