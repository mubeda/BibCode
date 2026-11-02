import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadShell,
} from "@bibcode/contracts";
import { describe, expect, it } from "vite-plus/test";

import { createOffShellThreads } from "./offShellThreads.ts";

const ENVIRONMENT = EnvironmentId.make("environment-1");

function thread(id: string, projectId = "project-1"): OrchestrationThreadShell {
  return {
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function page(ids: ReadonlyArray<string>, cursor: string | null = null) {
  return { threads: ids.map((id) => thread(id)), cursor };
}

describe("off-shell threads (#223)", () => {
  it("pages and dedupes against what it already loaded", () => {
    const store = createOffShellThreads();
    const generation = store.get(ENVIRONMENT).generation;
    store.applyPage(ENVIRONMENT, generation, "project", page(["a", "b"], "next"), false);
    store.applyPage(ENVIRONMENT, generation, "project", page(["b", "c"]), true);
    const state = store.get(ENVIRONMENT);
    expect(state.pages.get("project")).toEqual({ threadIds: ["a", "b", "c"], cursor: null });
    expect([...state.threads.keys()]).toEqual(["a", "b", "c"]);
  });

  it("a removal item drops a page copy", () => {
    const store = createOffShellThreads();
    store.applyPage(ENVIRONMENT, 0, "project", page(["a", "b"]), false);
    store.onShellItem(ENVIRONMENT, {
      kind: "thread-removed",
      sequence: 4,
      threadId: ThreadId.make("a"),
    });
    const state = store.get(ENVIRONMENT);
    expect(state.threads.has(ThreadId.make("a"))).toBe(false);
    expect(state.pages.get("project")?.threadIds).toEqual(["b"]);
  });

  it("project-removed drops its threads", () => {
    const store = createOffShellThreads();
    store.applyLookup(ENVIRONMENT, 0, {
      threads: [thread("a", "gone"), thread("b", "kept")],
      missing: [],
    });
    store.onShellItem(ENVIRONMENT, {
      kind: "project-removed",
      sequence: 4,
      projectId: ProjectId.make("gone"),
    });
    expect([...store.get(ENVIRONMENT).threads.keys()]).toEqual(["b"]);
  });

  it("any snapshot clears the store but remembers what is missing", () => {
    const store = createOffShellThreads();
    store.applyLookup(ENVIRONMENT, 0, {
      threads: [thread("a")],
      missing: [ThreadId.make("gone")],
    });
    store.onShellItem(ENVIRONMENT, {
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        projects: [],
        threads: [],
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
    });
    const state = store.get(ENVIRONMENT);
    expect(state.threads.size).toBe(0);
    expect(state.missing.has(ThreadId.make("gone"))).toBe(true);
  });

  it("a snapshot or a lookup that finds a missing thread clears its mark", () => {
    const store = createOffShellThreads();
    store.applyLookup(ENVIRONMENT, 0, {
      threads: [],
      missing: [ThreadId.make("restored"), ThreadId.make("found")],
    });
    store.onShellItem(ENVIRONMENT, {
      kind: "snapshot",
      snapshot: {
        snapshotSequence: 1,
        projects: [],
        threads: [thread("restored")],
        updatedAt: "2026-07-11T00:00:00.000Z",
      },
    });
    expect([...store.get(ENVIRONMENT).missing]).toEqual(["found"]);
    store.applyLookup(ENVIRONMENT, store.get(ENVIRONMENT).generation, {
      threads: [thread("found")],
      missing: [],
    });
    expect(store.get(ENVIRONMENT).missing.size).toBe(0);
  });

  it("drops a page reply that completes after a removal", () => {
    const store = createOffShellThreads();
    const sentAt = store.get(ENVIRONMENT).generation;
    store.onShellItem(ENVIRONMENT, {
      kind: "thread-removed",
      sequence: 4,
      threadId: ThreadId.make("a"),
    });
    expect(store.applyPage(ENVIRONMENT, sentAt, "project", page(["a"]), false)).toBe(false);
    expect(store.get(ENVIRONMENT).threads.has(ThreadId.make("a"))).toBe(false);
  });

  it("drops a lookup reply that completes after a snapshot", () => {
    const store = createOffShellThreads();
    const sentAt = store.get(ENVIRONMENT).generation;
    store.onShellItem(ENVIRONMENT, {
      kind: "unchanged",
      snapshotSequence: 3,
      revision: "r",
      activityAges: {},
    });
    expect(store.applyLookup(ENVIRONMENT, sentAt, { threads: [thread("a")], missing: [] })).toBe(
      false,
    );
    expect(store.get(ENVIRONMENT).threads.size).toBe(0);
  });

  it("forgets a removed environment, so no list shows its threads", () => {
    const store = createOffShellThreads();
    store.applyLookup(ENVIRONMENT, 0, { threads: [thread("a")], missing: [] });
    const before = store.version();
    store.forget(ENVIRONMENT);
    expect(store.environmentIds()).toEqual([]);
    expect(store.get(ENVIRONMENT).threads.size).toBe(0);
    expect(store.version()).toBeGreaterThan(before);
  });

  it("an upsert does not invalidate replies in flight", () => {
    const store = createOffShellThreads();
    const sentAt = store.get(ENVIRONMENT).generation;
    store.onShellItem(ENVIRONMENT, { kind: "thread-upserted", sequence: 2, thread: thread("x") });
    expect(store.applyPage(ENVIRONMENT, sentAt, "project", page(["a"]), false)).toBe(true);
  });
});
