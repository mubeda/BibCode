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
vi.mock("../../../state/pipelines", () => ({ pipelinesEnvironment: { get: h.get } }));
vi.mock("../../pullRequests/shared/usePullRequestsQuery", () => ({
  usePullRequestsQuery: (atom: { kind: string } | null) => ({
    data: h.settled && atom ? { kind: atom.kind } : null,
    error: null,
    isPending: !h.settled && atom !== null,
    emission: { _tag: "Initial" },
  }),
}));
vi.mock("../../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));

import { PipelinesListRow } from "./PipelinesListRow";

const scope = { environmentId: EnvironmentId.make("env"), cwd: "/repo" };
let root: Root;
let node: HTMLDivElement;

function renderRows(ids: readonly number[]) {
  act(() =>
    root.render(
      <>
        {ids.map((id) => (
          <PipelinesListRow
            key={id}
            row={{ ...pipelineRow, id, label: `#${id}` }}
            provider="gitlab"
            scope={scope}
            mutationsDisabledReason={null}
          />
        ))}
      </>,
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
