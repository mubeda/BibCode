import { beforeEach, describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_PIPELINES_FILTERS,
  sanitizePipelinesFilters,
  usePipelinesStore,
} from "./pipelinesStore";

const refA = { environmentId: "env", projectId: "a" } as never;
const refB = { environmentId: "env", projectId: "b" } as never;
const refC = { environmentId: "env", projectId: "c" } as never;

beforeEach(() => {
  usePipelinesStore.setState({ byProjectKey: {} });
});

describe("usePipelinesStore", () => {
  it("remembers each project's filters and resets its scroll position on a change", () => {
    const store = usePipelinesStore.getState();
    store.setScrollTop(refA, 300);
    store.setFilters(refA, { scope: "running", ref: "main", workflowId: null });
    expect(usePipelinesStore.getState().selectViewState(refA)).toMatchObject({
      filters: { scope: "running", ref: "main", workflowId: null },
      scrollTop: 0,
    });
    expect(usePipelinesStore.getState().selectViewState(refB).filters).toBe(
      DEFAULT_PIPELINES_FILTERS,
    );
  });

  it("keeps the two most recently used projects", () => {
    const store = usePipelinesStore.getState();
    store.setFilters(refA, { scope: "running", ref: null, workflowId: null });
    store.setFilters(refB, { scope: "finished", ref: null, workflowId: null });
    store.setFilters(refC, { scope: "all", ref: "x", workflowId: null });
    expect(Object.keys(usePipelinesStore.getState().byProjectKey)).toHaveLength(2);
    expect(usePipelinesStore.getState().selectViewState(refA).filters).toBe(
      DEFAULT_PIPELINES_FILTERS,
    );
  });

  it("sanitizes untrusted filters", () => {
    expect(sanitizePipelinesFilters({ scope: "later", ref: "  ", workflowId: 1.5 })).toEqual(
      DEFAULT_PIPELINES_FILTERS,
    );
    expect(sanitizePipelinesFilters(null)).toEqual(DEFAULT_PIPELINES_FILTERS);
  });
});
