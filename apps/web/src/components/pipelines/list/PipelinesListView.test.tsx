// @vitest-environment happy-dom
import { environmentRpcKey } from "@bibcode/client-runtime/state/runtime";
import {
  EnvironmentId,
  PullRequestsOperationError,
  type PipelinesChanged,
  type PipelinesListInput,
  type PipelinesListPage,
  type PipelinesSnapshot,
} from "@bibcode/contracts";
import * as Cause from "effect/Cause";
import { act, createRef, useReducer, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  DEFAULT_PIPELINES_FILTERS,
  usePipelinesStore,
  type PipelinesFilters,
} from "../../../pipelinesStore";
import { context } from "../../pullRequests/testFixtures";
import { gitlabContext } from "../../pullRequests/detail/testFixtures";
import {
  RepositoryModule,
  type RepositoryModuleValue,
} from "../../repositoryModule/RepositoryModule";
import { clearResourceRefusals } from "../../repositoryModule/resourceRefusal";
import { expectLoadingModel } from "../../ui/loading-state.testing";
import { pipelinesModule } from "../pipelinesModule";
import { pipelineRow, pipelinesPage } from "../testFixtures";
import { buildPipelinesListInput } from "./pipelinesList.logic";

const h = vi.hoisted(() => ({
  first: null as PipelinesListPage | null,
  second: null as PipelinesListPage | null,
  error: null as PullRequestsOperationError | null,
  pending: false,
  // The stored copy's read is in flight, as after a change event.
  snapshotPending: false,
  // The error answers the first page's read only; later pages stay settled.
  firstOnlyError: false,
  // The error answers a later page's read only; the first page stays settled.
  laterOnlyError: false,
  // Only the first page's read is in flight, as a timer refresh leaves page two alone.
  firstOnly: false,
  failures: new Map<object, unknown>(),
  snapshot: null as PipelinesSnapshot | null,
  nextSnapshot: null as PipelinesSnapshot | null,
  changed: null as PipelinesChanged | null,
  streamFailed: false,
  list: vi.fn((args: { input: PipelinesListInput }) => ({ kind: "list", ...args })),
  get: vi.fn((args: { input: unknown }) => ({ kind: "get", ...args })),
  snapshotReads: vi.fn(),
  subscribe: vi.fn((args: { input: unknown }) => ({ kind: "subscribe", ...args })),
  requestTimerRead: vi.fn(),
  actions: vi.fn(),
  reads: vi.fn(),
  // Reads in flight; `settle` answers them in a later turn, as the atom runtime does.
  inflight: [] as (() => void)[],
  rowRenders: vi.fn(),
}));
vi.mock("../usePipelineHoverPrefetch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../usePipelineHoverPrefetch")>();
  return {
    ...actual,
    // Called once per row render, so it counts them.
    usePipelineHoverPrefetch: (...args: Parameters<typeof actual.usePipelineHoverPrefetch>) => {
      h.rowRenders();
      return actual.usePipelineHoverPrefetch(...args);
    },
  };
});
vi.mock("../../../state/pipelines", () => ({
  pipelinesEnvironment: {
    list: h.list,
    get: h.get,
    readSnapshot: vi.fn((args: { input: unknown }) => ({ kind: "readSnapshot", ...args })),
    subscribe: h.subscribe,
    requestTimerRead: h.requestTimerRead,
    runAction: { label: "environment-data:pipelines:run-action" },
  },
}));
vi.mock("../../../state/use-atom-command", () => ({
  useAtomCommand: () => async (value: unknown) => {
    h.actions(value);
    return { _tag: "Success", value: { pipelineId: 4821, jobId: null } };
  },
}));
vi.mock("../../../state/vcs", () => ({
  vcsEnvironment: { listRefs: vi.fn(() => ({ kind: "refs" })) },
}));
vi.mock("../../../state/query", () => ({
  useEnvironmentQuery: (atom: { kind: string; input: PipelinesListInput } | null) => {
    const [, publish] = useReducer((value: number) => value + 1, 0);
    if (atom !== null && (atom.kind === "readSnapshot" || atom.kind === "subscribe")) {
      const value = atom.kind === "readSnapshot" ? h.snapshot : h.changed;
      const read = () => {
        h.snapshotReads(atom.kind);
        if (atom.kind === "readSnapshot" && h.nextSnapshot) h.snapshot = h.nextSnapshot;
        publish();
      };
      const emission =
        atom.kind === "subscribe" && h.streamFailed
          ? { _tag: "Failure", cause: Cause.fail(new Error("stream down")) }
          : value
            ? { _tag: "Success", value }
            : { _tag: "Initial" };
      return {
        data: value,
        emission,
        error: null,
        isPending: atom.kind === "readSnapshot" && h.snapshotPending,
        refresh: read,
        revalidate: read,
        requiresRetry: false,
      };
    }
    if (atom === null || atom.kind !== "list")
      return {
        data: null,
        emission: { _tag: "Initial" },
        error: null,
        isPending: false,
        refresh: () => {},
        revalidate: () => {},
        requiresRetry: false,
      };
    const data = atom.input.cursor === null ? h.first : h.second;
    const error =
      (h.firstOnlyError && atom.input.cursor !== null) ||
      (h.laterOnlyError && atom.input.cursor === null)
        ? null
        : h.error;
    if (error && !h.failures.has(error))
      h.failures.set(error, { _tag: "Failure", cause: Cause.fail(error) });
    // A read stays pending until `settle`, then answers with a new copy of the page.
    const read = () => {
      h.reads(atom.input.cursor);
      h.pending = true;
      publish();
      h.inflight.push(() => {
        h.pending = false;
        if (h.first) h.first = { ...h.first, rows: [...h.first.rows] };
        if (h.second) h.second = { ...h.second, rows: [...h.second.rows] };
        if (h.error) h.failures.delete(h.error);
        publish();
      });
    };
    return {
      data,
      emission: error ? h.failures.get(error) : { _tag: "Success", value: data },
      error: error?.message ?? null,
      isPending: h.pending && (!h.firstOnly || atom.input.cursor === null),
      refresh: read,
      revalidate: read,
      requiresRetry: false,
    };
  },
}));
vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: readonly unknown[];
    keyExtractor: (item: unknown) => string;
    renderItem: (p: { item: unknown; index: number }) => ReactNode;
  }) => (
    <div role="list">
      {props.data.map((item, index) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item, index })}</div>
      ))}
    </div>
  ),
}));
vi.mock("../../../lib/openPullRequestLink", () => ({ useOpenPrLink: () => vi.fn() }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, className }: { children: ReactNode; className?: string }) => (
    <a className={className}>{children}</a>
  ),
}));

import { PipelinesListView, type PipelinesListViewHandle } from "./PipelinesListView";

const projectRef = { environmentId: "env", projectId: "p" } as never;
const scope = { environmentId: EnvironmentId.make("env"), cwd: "/repo" };
const SERVER_TOO_OLD = "Update the server to retry and cancel pipelines.";
let container: HTMLDivElement;
let root: Root;
const handle = createRef<PipelinesListViewHandle>();
const onFiltersChange = vi.fn();
const onBackoffChange = vi.fn();

function moduleValue(
  repositoryContext: typeof context,
  freshPageKey: string | null = null,
): RepositoryModuleValue {
  return {
    state: {
      availability: { kind: "ready" },
      project: null,
      cwd: scope.cwd,
      scope,
      context: repositoryContext,
      contextQuery: {} as never,
      storedContext: false,
      worktreeOptions: [],
      worktreeStatus: null,
      freshPageKey,
    },
    actions: { rescan: vi.fn(), recover: vi.fn(), setCwd: vi.fn(), consumeFreshPage: vi.fn() },
    meta: {
      module: pipelinesModule,
      projectRef,
      mutationsDisabledReason: SERVER_TOO_OLD,
    },
  };
}

async function settle() {
  await act(async () => {
    for (const answer of h.inflight.splice(0)) answer();
  });
}
async function render(
  options: {
    provider?: "gitlab" | "github";
    filters?: PipelinesFilters;
    value?: RepositoryModuleValue;
  } = {},
) {
  const value =
    options.value ?? moduleValue(options.provider === "github" ? context : gitlabContext);
  await act(async () =>
    root.render(
      <RepositoryModule.Provider value={value}>
        <PipelinesListView
          ref={handle}
          filters={options.filters ?? DEFAULT_PIPELINES_FILTERS}
          onFiltersChange={onFiltersChange}
          onBackoffChange={onBackoffChange}
        />
      </RepositoryModule.Provider>,
    ),
  );
  await settle();
}
function button(text: string) {
  const found = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!found) throw new Error(`Missing ${text}`);
  return found;
}
function stored(title: string, observedAt: number, revision = 1): PipelinesSnapshot {
  return {
    list: { payload: pipelinesPage([{ ...pipelineRow, title }], { revision }), observedAt },
    detail: null,
    job: null,
  };
}
function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  usePipelinesStore.setState({ byProjectKey: {} });
  clearResourceRefusals();
  localStorage.clear();
  h.first = pipelinesPage([pipelineRow], { nextCursor: "c2" });
  h.second = pipelinesPage([{ ...pipelineRow, id: 4700, label: "#4700", title: "Second page" }]);
  h.error = null;
  h.pending = false;
  h.snapshotPending = false;
  h.firstOnlyError = false;
  h.laterOnlyError = false;
  h.firstOnly = false;
  h.failures.clear();
  h.snapshot = null;
  h.nextSnapshot = null;
  h.changed = null;
  h.streamFailed = false;
  h.list.mockClear();
  h.get.mockClear();
  h.snapshotReads.mockClear();
  h.subscribe.mockClear();
  h.requestTimerRead.mockClear();
  h.reads.mockClear();
  h.inflight = [];
  onFiltersChange.mockClear();
  onBackoffChange.mockClear();
  setVisibility("visible");
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("PipelinesListView", () => {
  it("renders a row with its status, ref, sha, badges and named stage icons", async () => {
    await render();
    expect(h.list).toHaveBeenCalledWith({
      environmentId: "env",
      input: buildPipelinesListInput(DEFAULT_PIPELINES_FILTERS, "/repo"),
    });
    const row = container.querySelector('[role="row"][aria-label]')!;
    expect(row.getAttribute("aria-label")).toBe("#4821 Failed");
    expect(row.textContent).toContain("Fix connection recovery");
    expect(row.textContent).toContain("main");
    expect(row.textContent).toContain("abc1234d");
    expect(row.textContent).toContain("latest");
    expect(row.textContent).toContain("4m 12s");
    expect(row.textContent).toContain("Ana Rossi");
    expect(row.querySelector('[aria-label="test: failed"]')).not.toBeNull();
    expect(row.querySelector('[aria-label="build: passed"]')?.getAttribute("title")).toBe(
      "build: passed",
    );
  });

  it("hides retained rows and actions when a refresh is refused, and keeps them for a recoverable failure", async () => {
    await render();
    expect(container.textContent).toContain("Fix connection recovery");
    h.error = new PullRequestsOperationError({
      operation: "pipelines.list",
      code: "provider_error",
      message: "GitLab timed out.",
      hostDetail: null,
      retryable: true,
    });
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("timed out");
    expect(container.textContent).toContain("Fix connection recovery");
    h.error = new PullRequestsOperationError({
      operation: "pipelines.list",
      code: "forbidden",
      message: "You can't view these pipelines.",
      hostDetail: null,
      retryable: false,
    });
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("can't view");
    expect(container.textContent).not.toContain("Fix connection recovery");
    expect(container.querySelector('[role="table"]')).toBeNull();
    expect(container.textContent).not.toContain("Load more");
  });

  it("keeps later pages, and the rows, until a Refresh read succeeds", async () => {
    await render();
    await act(async () => button("Load more").click());
    await settle();
    expect(container.textContent).toContain("Second page");
    await act(async () => handle.current!.refresh());
    expect(container.textContent).toContain("Second page");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Refreshing pipelines…",
    );
    await settle();
    expect(container.textContent).not.toContain("Second page");
    expect(container.textContent).toContain("Fix connection recovery");
  });

  it("shows the refresh label for the first page's read while page two is shown", async () => {
    await render();
    await act(async () => button("Load more").click());
    await settle();
    h.pending = true;
    h.firstOnly = true;
    await render();
    expect(container.textContent).toContain("Second page");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Refreshing pipelines…",
    );
  });

  it("shows the refresh label while a stored first page waits for the live one", async () => {
    h.first = null;
    h.pending = true;
    h.snapshot = stored("Stored title", 1_000);
    await render();
    expect(container.textContent).toContain("Stored title");
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Refreshing pipelines…",
    );
  });

  it("keeps the empty message and Clear filter while a settled empty list refreshes", async () => {
    h.first = pipelinesPage([]);
    const filters = { ...DEFAULT_PIPELINES_FILTERS, ref: "release" };
    await render({ filters });
    expect(container.textContent).toContain("Clear filter");
    h.pending = true;
    await render({ filters });
    expect(container.textContent).toContain("Clear filter");
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toContain("Refreshing pipelines…");
    expect(container.textContent).not.toContain("Loading pipelines…");
  });

  it("labels a first load, then keeps the rows beside a refresh label", async () => {
    h.first = null;
    h.pending = true;
    await render();
    expectLoadingModel(container, ["Loading pipelines…"]);
    expect(container.querySelector('[role="status"] svg.animate-spin')).not.toBeNull();
    h.pending = false;
    h.first = pipelinesPage([{ ...pipelineRow, title: "Live title" }], { revision: 1 });
    await render();
    expect(container.querySelector('[role="status"]')).toBeNull();
    h.pending = true;
    await render();
    expect(container.textContent).toContain("Live title");
    expectLoadingModel(container, ["Refreshing pipelines…"]);
  });

  it("paints the stored first page before the live read answers, then the live one", async () => {
    h.first = null;
    h.pending = true;
    h.snapshot = stored("Stored title", 1_000);
    await render();
    expect(container.textContent).toContain("Stored title");
    h.pending = false;
    h.first = pipelinesPage([{ ...pipelineRow, title: "Live title" }], { revision: 2 });
    await render();
    expect(container.textContent).toContain("Live title");
    expect(container.textContent).not.toContain("Stored title");
  });

  it("never replaces a newer live page with a late, older stored copy", async () => {
    h.first = pipelinesPage([{ ...pipelineRow, title: "Live title" }], { revision: 5 });
    await render();
    h.snapshot = stored("Old stored title", 0);
    await render();
    expect(container.textContent).toContain("Live title");
    expect(container.textContent).not.toContain("Old stored title");
  });

  it("ignores a stored copy on GitHub once its live page answered", async () => {
    h.first = pipelinesPage([{ ...pipelineRow, title: "Live title" }]);
    await render({ provider: "github" });
    h.snapshot = stored("Late stored title", Date.now() + 60_000);
    await render({ provider: "github" });
    expect(container.textContent).toContain("Live title");
    expect(container.textContent).not.toContain("Late stored title");
  });

  it("maps the tabs to the list scope", async () => {
    await render();
    await act(async () => button("Running").click());
    expect(onFiltersChange).toHaveBeenCalledWith({
      ...DEFAULT_PIPELINES_FILTERS,
      scope: "running",
    });
  });

  it("appends Load more and keeps page two when the poller names the list", async () => {
    await render();
    expect(h.subscribe).toHaveBeenCalledWith({
      environmentId: "env",
      input: expect.objectContaining({ cursor: null, pipelineId: null, jobId: null }),
    });
    await act(async () => button("Load more").click());
    await settle();
    expect(h.list).toHaveBeenLastCalledWith({
      environmentId: "env",
      input: expect.objectContaining({ cursor: "c2" }),
    });
    expect(container.textContent).toContain("Second page");
    h.changed = { list: true, pipeline: false };
    h.nextSnapshot = stored("Polled title", Date.now() + 60_000, 9);
    await render();
    expect(h.snapshotReads).toHaveBeenCalledWith("readSnapshot");
    expect(container.textContent).toContain("Polled title");
    expect(container.textContent).toContain("Second page");
  });

  it("says when a tab has nothing, and offers to clear a ref filter", async () => {
    h.first = pipelinesPage([]);
    await render({ filters: { ...DEFAULT_PIPELINES_FILTERS, scope: "running" } });
    expect(container.textContent).toContain("Nothing running");
    await render({ filters: { ...DEFAULT_PIPELINES_FILTERS, ref: "release" } });
    expect(container.textContent).toContain("No pipelines on release");
    await act(async () => button("Clear filter").click());
    expect(onFiltersChange).toHaveBeenCalledWith(DEFAULT_PIPELINES_FILTERS);
  });

  it("offers GitHub's Workflow filter from its first page, and GitLab none", async () => {
    h.first = { ...pipelinesPage([pipelineRow]), workflows: [{ id: 77, name: "CI" }] };
    await render({ provider: "github", filters: { ...DEFAULT_PIPELINES_FILTERS, workflowId: 77 } });
    const trigger = container.querySelector('[aria-label="Workflow"]');
    expect(trigger?.textContent).toContain("CI");
    await render({ provider: "gitlab" });
    expect(container.querySelector('[aria-label="Workflow"]')).toBeNull();
  });

  it("says a GitHub repository has no workflows, and clears a workflow filter", async () => {
    h.first = { ...pipelinesPage([]), workflows: [] };
    await render({ provider: "github" });
    expect(container.textContent).toContain("This repository has no workflows.");
    h.first = { ...pipelinesPage([]), workflows: [{ id: 77, name: "CI" }] };
    await render({ provider: "github", filters: { ...DEFAULT_PIPELINES_FILTERS, workflowId: 77 } });
    expect(container.textContent).toContain("No runs of CI");
    await act(async () => button("Clear filter").click());
    expect(onFiltersChange).toHaveBeenCalledWith(DEFAULT_PIPELINES_FILTERS);
  });

  it("says when GitHub stopped a filtered list at 1,000 runs", async () => {
    h.first = { ...pipelinesPage([pipelineRow]), total: { count: 1_000, capped: true } };
    await render({ provider: "github" });
    expect(container.textContent).toContain("GitHub returns at most 1,000 filtered runs.");
  });

  it("disables Retry with the host's refusal, and otherwise with the server's reason", async () => {
    h.first = pipelinesPage([
      { ...pipelineRow, permissions: { retry: "denied", cancel: "granted" } },
      { ...pipelineRow, id: 4822, label: "#4822" },
    ]);
    await render();
    const denied = container.querySelector<HTMLButtonElement>(
      '[aria-label="Retry pipeline #4821"]',
    )!;
    expect(denied.disabled).toBe(true);
    expect(denied.title).toBe("You don't have permission to retry pipelines in this project.");
    const other = container.querySelector<HTMLButtonElement>(
      '[aria-label="Retry pipeline #4822"]',
    )!;
    expect(other.disabled).toBe(true);
    expect(other.title).toBe(SERVER_TOO_OLD);
    expect(container.querySelector('[aria-label="Cancel pipeline #4821"]')).toBeNull();
  });

  it("retries a row's pipeline and reads the first page again", async () => {
    const base = moduleValue(gitlabContext);
    await render({ value: { ...base, meta: { ...base.meta, mutationsDisabledReason: null } } });
    h.reads.mockClear();
    const retry = container.querySelector<HTMLButtonElement>(
      '[aria-label="Retry pipeline #4821"]',
    )!;
    await act(async () => retry.click());
    expect(h.actions).toHaveBeenCalledExactlyOnceWith({
      environmentId: "env",
      input: { cwd: "/repo", target: { _tag: "pipeline", id: 4821 }, action: "retry" },
    });
    expect(h.reads).toHaveBeenCalledWith(null);
  });

  it("shows a first page read alongside the context without reading it again", async () => {
    const input = buildPipelinesListInput(DEFAULT_PIPELINES_FILTERS, "/repo");
    const key = environmentRpcKey({ environmentId: scope.environmentId, input });
    const value = moduleValue(gitlabContext, key);
    await render({ value });
    expect(container.textContent).toContain("Fix connection recovery");
    expect(value.actions.consumeFreshPage).toHaveBeenCalledWith(key);
    expect(h.reads).not.toHaveBeenCalled();
  });

  describe("a refusal stays in force until a later read of the same list succeeds", () => {
    const refused = new PullRequestsOperationError({
      operation: "pipelines.list",
      code: "forbidden",
      message: "You can't view these",
      hostDetail: null,
      retryable: false,
    });
    const timedOut = new PullRequestsOperationError({
      operation: "pipelines.list",
      code: "provider_error",
      message: "Host timed out",
      hostDetail: null,
      retryable: true,
    });
    const filtered = { ...DEFAULT_PIPELINES_FILTERS, ref: "release" };
    const steps = {
      refusal: async () => {
        h.error = refused;
        await render({ filters: filtered });
      },
      timeout: async () => {
        h.error = timedOut;
        await render({ filters: filtered });
      },
      // Clearing the filter shows another list; setting it again re-keys this one's pages.
      filterRoundTrip: async () => {
        await render();
        await render({ filters: filtered });
      },
      pendingRefresh: async () => {
        h.error = null;
        await act(async () => handle.current!.refresh());
      },
      // The stored copy paints the refused rows again unless the refusal outlives the view.
      reopen: async () => {
        h.snapshot = stored("Fix connection recovery", 1);
        await act(async () => root.unmount());
        root = createRoot(container);
        await render({ filters: filtered });
      },
    };
    it.each<[string, (keyof typeof steps)[]]>([
      ["refusal, then a timeout", ["refusal", "timeout"]],
      ["timeout, then refusal, then timeout", ["timeout", "refusal", "timeout"]],
      [
        "refusal, then a timeout, then a filter round trip",
        ["refusal", "timeout", "filterRoundTrip"],
      ],
      ["refusal, then a refresh still in flight", ["refusal", "pendingRefresh"]],
      ["refusal, then a timeout, then reopening the list", ["refusal", "timeout", "reopen"]],
    ])("%s", async (_name, order) => {
      await render({ filters: filtered });
      expect(container.textContent).toContain("Fix connection recovery");
      expect(button("All 1")).toBeDefined();
      for (const step of order) await steps[step]();
      expect(container.textContent).not.toContain("Fix connection recovery");
      expect(container.querySelector('[aria-label="Retry pipeline #4821"]')).toBeNull();
      // The tab count came from the refused list too.
      expect(button("All")).toBeDefined();
      // Only a read the host answers lifts it.
      h.error = null;
      await act(async () => handle.current!.refresh());
      await settle();
      expect(container.textContent).toContain("Fix connection recovery");
    });
  });
  it("hides later pages when only the first page's refresh is refused", async () => {
    await render();
    await act(async () => button("Load more").click());
    await settle();
    expect(container.textContent).toContain("Second page");
    h.firstOnlyError = true;
    h.error = new PullRequestsOperationError({
      operation: "pipelines.list",
      code: "forbidden",
      message: "You can't view these pipelines.",
      hostDetail: null,
      retryable: false,
    });
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("can't view");
    expect(container.textContent).not.toContain("Second page");
    expect(container.querySelector('[role="table"]')).toBeNull();
  });

  it("hides every page and the count when only the Load more read is refused", async () => {
    await render();
    expect(button("All 1")).toBeDefined();
    h.laterOnlyError = true;
    h.error = new PullRequestsOperationError({
      operation: "pipelines.list",
      code: "forbidden",
      message: "You can't view these pipelines.",
      hostDetail: null,
      retryable: false,
    });
    await act(async () => button("Load more").click());
    await settle();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("can't view");
    expect(container.textContent).not.toContain("Second page");
    expect(container.querySelector('[role="table"]')).toBeNull();
    // The tab count came from the refused list too.
    expect(button("All")).toBeDefined();
    // Retry reads the list again from its first page; the host's answer lifts the refusal.
    h.error = null;
    h.laterOnlyError = false;
    h.reads.mockClear();
    await act(async () => button("Retry").click());
    await settle();
    expect(h.reads).toHaveBeenCalledWith(null);
    expect(container.textContent).toContain("Fix connection recovery");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("counts down a first-page rate limit while page two is shown", async () => {
    await render();
    await act(async () => button("Load more").click());
    await settle();
    h.firstOnlyError = true;
    h.error = new PullRequestsOperationError({
      operation: "pipelines.list",
      code: "rate_limited",
      message: "GitLab's rate limit was reached.",
      hostDetail: null,
      retryable: true,
      retryAfterSeconds: 3,
    });
    await render();
    expect(container.textContent).toContain("Trying again in 3 s.");
    expect(button("Retry").disabled).toBe(true);
    expect(onBackoffChange).toHaveBeenLastCalledWith(true);
  });

  it("shows a first-page failure that is not a refusal while page two is shown", async () => {
    await render();
    await act(async () => button("Load more").click());
    await settle();
    h.firstOnlyError = true;
    h.error = new PullRequestsOperationError({
      operation: "pipelines.list",
      code: "provider_error",
      message: "GitLab timed out.",
      hostDetail: null,
      retryable: true,
    });
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("timed out");
    expect(container.textContent).toContain("Second page");
  });

  it("shows the refresh label while a change event's stored read is pending", async () => {
    await render();
    expect(container.querySelector('[role="status"]')).toBeNull();
    h.snapshotPending = true;
    await render();
    expect(container.querySelector('[role="status"]')?.textContent).toContain(
      "Refreshing pipelines…",
    );
  });

  it("counts down a rate limit and reads again when it passes", async () => {
    vi.useFakeTimers();
    h.first = null;
    h.error = new PullRequestsOperationError({
      operation: "pipelines.list",
      code: "rate_limited",
      message: "GitLab's rate limit was reached.",
      hostDetail: null,
      retryable: true,
      retryAfterSeconds: 3,
    });
    await render();
    expect(container.textContent).toContain("Trying again in 3 s.");
    expect(button("Retry").disabled).toBe(true);
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(container.textContent).toContain("Trying again in 2 s.");
    h.requestTimerRead.mockClear();
    await act(async () => vi.advanceTimersByTime(2_000));
    expect(h.requestTimerRead).toHaveBeenCalledOnce();
  });
});

describe("PipelinesListView request budget", () => {
  const HOUR = 3_600_000;
  async function runFor(ms: number) {
    for (let elapsed = 0; elapsed < ms; elapsed += 5_000) {
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      await settle();
    }
  }

  it("issues no timer reads on GitLab while the stream is live, and 180 an hour after it fails", async () => {
    vi.useFakeTimers();
    h.changed = { list: false, pipeline: false };
    await render();
    await runFor(HOUR);
    expect(h.requestTimerRead).not.toHaveBeenCalled();
    h.streamFailed = true;
    await render();
    await runFor(HOUR);
    expect(h.requestTimerRead.mock.calls.length).toBeGreaterThanOrEqual(179);
    expect(h.requestTimerRead.mock.calls.length).toBeLessThanOrEqual(180);
  });

  it("reads GitHub every 20 s only while a shown pipeline runs, and never while hidden", async () => {
    vi.useFakeTimers();
    h.first = pipelinesPage([{ ...pipelineRow, status: "running", terminal: false }]);
    await render({ provider: "github" });
    expect(h.subscribe).not.toHaveBeenCalled();
    await runFor(HOUR);
    expect(h.requestTimerRead.mock.calls.length).toBeGreaterThanOrEqual(179);
    expect(h.requestTimerRead.mock.calls.length).toBeLessThanOrEqual(180);

    h.requestTimerRead.mockClear();
    setVisibility("hidden");
    await runFor(HOUR);
    expect(h.requestTimerRead).not.toHaveBeenCalled();
  });

  it("issues no GitHub timer reads when every shown pipeline is finished", async () => {
    vi.useFakeTimers();
    await render({ provider: "github" });
    await runFor(HOUR);
    expect(h.requestTimerRead).not.toHaveBeenCalled();
  });
});

describe("PipelinesListView columns", () => {
  const rootGrid = () =>
    container
      .querySelector<HTMLElement>(".\\@container")!
      .style.getPropertyValue("--pipelines-grid-full");
  const separator = (name: string) =>
    container.querySelector<HTMLElement>(`[role="separator"][aria-label="${name}"]`)!;
  const press = (element: HTMLElement, key: string) =>
    act(() =>
      element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })),
    );

  it("names the five columns in a header above the rows, and drops it when the list is empty", async () => {
    await render();
    const names = [...container.querySelectorAll('[role="columnheader"]')].map((cell) =>
      cell.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(names).toEqual(["Status", "Pipeline", "Created by", "Stages", "Actions"]);
    expect(container.querySelector('[role="table"] [role="rowgroup"] [role="row"]')).not.toBeNull();
    h.first = pipelinesPage([]);
    await render();
    expect(container.querySelector('[role="columnheader"]')).toBeNull();
  });

  it("resizes with the keyboard, persists, and restores the width after a reload", async () => {
    await render();
    const pipeline = separator("Resize Pipeline column");
    expect(pipeline.getAttribute("aria-valuenow")).toBe("480");
    expect(rootGrid()).toBe(
      "168px minmax(240px,480px) minmax(96px,160px) minmax(72px,160px) 104px",
    );
    press(pipeline, "ArrowRight");
    expect(rootGrid()).toBe(
      "168px minmax(240px,496px) minmax(96px,160px) minmax(72px,160px) 104px",
    );
    press(separator("Resize Stages column"), "End");
    press(separator("Resize Created by column"), "Home");
    expect(rootGrid()).toBe("168px minmax(240px,496px) minmax(96px,96px) minmax(72px,360px) 104px");
    expect(
      localStorage.getItem("bibcode:pipelines-list-pipeline-width:github.com/owner/repo"),
    ).toBe("496");
    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(rootGrid()).toBe("168px minmax(240px,496px) minmax(96px,96px) minmax(72px,360px) 104px");
    press(separator("Resize Pipeline column"), "ArrowLeft");
    press(separator("Resize Pipeline column"), "ArrowLeft");
    expect(separator("Resize Pipeline column").getAttribute("aria-valuenow")).toBe("464");
  });

  it("resets a column on double-click and never leaves its bounds", async () => {
    await render();
    const stagesSeparator = separator("Resize Stages column");
    for (let press_ = 0; press_ < 40; press_ += 1) press(stagesSeparator, "ArrowRight");
    expect(stagesSeparator.getAttribute("aria-valuenow")).toBe("360");
    act(() => stagesSeparator.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(stagesSeparator.getAttribute("aria-valuenow")).toBe("160");
  });

  it("clamps stored widths and falls back to the default for a corrupt one", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.setItem("bibcode:pipelines-list-pipeline-width", "99999");
    localStorage.setItem("bibcode:pipelines-list-author-width", "{not json");
    localStorage.setItem("bibcode:pipelines-list-stages-width", "1");
    await render();
    expect(rootGrid()).toBe("168px minmax(240px,960px) minmax(96px,160px) minmax(72px,72px) 104px");
    error.mockRestore();
  });

  it("keeps each repository's widths and hidden columns, starting from the global choice", async () => {
    localStorage.setItem("bibcode:pipelines-list-pipeline-width", "400");
    localStorage.setItem("bibcode:pipelines-list-hidden-columns", JSON.stringify(["author"]));
    const other = moduleValue({ ...gitlabContext, repository: "group/other" });
    await render();
    expect(rootGrid()).toBe("168px minmax(240px,400px) minmax(72px,160px) 104px");
    press(separator("Resize Pipeline column"), "ArrowRight");
    await act(async () =>
      container
        .querySelector<HTMLElement>('[aria-label="Choose columns"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    const author = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find(
      (candidate) => candidate.textContent === "Created by",
    ) as HTMLElement;
    await act(async () => author.click());
    expect(rootGrid()).toBe(
      "168px minmax(240px,416px) minmax(96px,160px) minmax(72px,160px) 104px",
    );
    // Another repository, in the same mounted panel, still starts from the global choice.
    await render({ value: other });
    expect(rootGrid()).toBe("168px minmax(240px,400px) minmax(72px,160px) 104px");
    expect(localStorage.getItem("bibcode:pipelines-list-pipeline-width")).toBe("400");
    expect(localStorage.getItem("bibcode:pipelines-list-hidden-columns")).toBe('["author"]');
    await render();
    expect(rootGrid()).toBe(
      "168px minmax(240px,416px) minmax(96px,160px) minmax(72px,160px) 104px",
    );
  });

  it("falls back to the global choice for a corrupt or out-of-range repository value", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    localStorage.setItem("bibcode:pipelines-list-author-width", "200");
    localStorage.setItem("bibcode:pipelines-list-hidden-columns", JSON.stringify(["stages"]));
    localStorage.setItem("bibcode:pipelines-list-pipeline-width:github.com/owner/repo", "99999");
    localStorage.setItem("bibcode:pipelines-list-author-width:github.com/owner/repo", "{not json");
    localStorage.setItem("bibcode:pipelines-list-hidden-columns:github.com/owner/repo", '["nope"]');
    await render();
    expect(rootGrid()).toBe("168px minmax(240px,960px) minmax(96px,200px) 104px");
    error.mockRestore();
  });

  it("does not re-render a row while a column is resized", async () => {
    await render();
    expect(h.rowRenders).toHaveBeenCalled();
    h.rowRenders.mockClear();
    press(separator("Resize Pipeline column"), "ArrowRight");
    press(separator("Resize Stages column"), "ArrowLeft");
    expect(rootGrid()).toContain("496px");
    expect(h.rowRenders).not.toHaveBeenCalled();
  });

  it("removes a hidden column from the header and every row, and remembers the choice", async () => {
    localStorage.setItem("bibcode:pipelines-list-hidden-columns", JSON.stringify(["author"]));
    await render();
    const headers = [...container.querySelectorAll('[role="columnheader"]')].map((cell) =>
      cell.textContent?.replace(/\s+/g, " ").trim(),
    );
    expect(headers).toEqual(["Status", "Pipeline", "Stages", "Actions"]);
    expect(container.querySelector('[role="row"][aria-label]')!.textContent).not.toContain(
      "Ana Rossi",
    );
    expect(rootGrid()).toBe("168px minmax(240px,480px) minmax(72px,160px) 104px");
  });

  it("hides a column from the header menu", async () => {
    await render();
    await act(async () =>
      container
        .querySelector<HTMLElement>('[aria-label="Choose columns"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    const item = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find(
      (candidate) => candidate.textContent === "Stages",
    ) as HTMLElement;
    expect(item.getAttribute("aria-checked")).toBe("true");
    await act(async () => item.click());
    expect(
      localStorage.getItem("bibcode:pipelines-list-hidden-columns:github.com/owner/repo"),
    ).toBe('["stages"]');
    expect(rootGrid()).toBe("168px minmax(240px,480px) minmax(96px,160px) 104px");
    expect(container.querySelector('ol[aria-label="Stages"]')).toBeNull();
  });

  it("keeps Actions inside a 1100 px row at the widest widths a user can set", async () => {
    localStorage.setItem("bibcode:pipelines-list-pipeline-width", "960");
    localStorage.setItem("bibcode:pipelines-list-author-width", "320");
    localStorage.setItem("bibcode:pipelines-list-stages-width", "360");
    await render();
    // Every track but Status and Actions may shrink to its minimum, so the smallest
    // the row needs is far below the 1100 px step.
    const minimum = 168 + 240 + 96 + 72 + 104 + 4 * 12 + 32;
    expect(rootGrid()).toBe(
      "168px minmax(240px,960px) minmax(96px,320px) minmax(72px,360px) 104px",
    );
    expect(minimum).toBeLessThan(1100);
  });

  it("numbers the rows for assistive technology, header first, with the host's total", async () => {
    await render();
    const table = container.querySelector('[role="table"]')!;
    expect(table.getAttribute("aria-rowcount")).toBe("2");
    const header = container.querySelector('[role="columnheader"]')!.closest("[role=row]")!;
    expect(header.getAttribute("aria-rowindex")).toBe("1");
    expect(container.querySelector('[role="row"][aria-label]')!.getAttribute("aria-rowindex")).toBe(
      "2",
    );
  });

  it("says the row count is unknown when the host's total is capped", async () => {
    h.first = { ...pipelinesPage([pipelineRow]), total: { count: 1000, capped: true } };
    await render();
    expect(container.querySelector('[role="table"]')!.getAttribute("aria-rowcount")).toBe("-1");
  });

  it("hides the duration and age text from the header menu and remembers it", async () => {
    await render();
    expect(container.querySelector('[role="row"][aria-label]')!.textContent).toContain("4m 12s");
    await act(async () =>
      container
        .querySelector<HTMLElement>('[aria-label="Choose columns"]')!
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    const item = [...document.querySelectorAll('[role="menuitemcheckbox"]')].find(
      (candidate) => candidate.textContent === "Duration and age",
    ) as HTMLElement;
    await act(async () => item.click());
    expect(
      localStorage.getItem("bibcode:pipelines-list-hidden-columns:github.com/owner/repo"),
    ).toBe('["timing"]');
    const row = container.querySelector('[role="row"][aria-label]')!;
    expect(row.textContent).not.toContain("4m 12s");
    expect(row.textContent).toContain("Failed");
  });
});
