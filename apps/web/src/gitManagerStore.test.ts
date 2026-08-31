import { projectKey } from "@bibcode/client-runtime/state/entities";
import type { ScopedProjectRef } from "@bibcode/contracts";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createJSONStorage } from "zustand/middleware";

import { GIT_MANAGER_STORAGE_KEY, useGitManagerStore } from "./gitManagerStore";

const ref = (environmentId: string, projectId: string) =>
  ({ environmentId, projectId }) as ScopedProjectRef;

const persisted = new Map<string, string>();
const storage = {
  getItem: (name: string) => persisted.get(name) ?? null,
  setItem: (name: string, value: string) => {
    persisted.set(name, value);
  },
  removeItem: (name: string) => {
    persisted.delete(name);
  },
};

describe("gitManagerStore", () => {
  beforeEach(() => {
    persisted.clear();
    useGitManagerStore.persist.setOptions({ storage: createJSONStorage(() => storage) });
    useGitManagerStore.setState({ byProjectKey: {} });
  });

  it("evicts the least recently used project when a third is touched", () => {
    const store = useGitManagerStore.getState();
    store.touchProject(ref("env-a", "p1"));
    store.touchProject(ref("env-a", "p2"));
    store.touchProject(ref("env-a", "p3"));

    const keys = Object.keys(useGitManagerStore.getState().byProjectKey);
    expect(keys).toHaveLength(2);
    expect(keys).not.toContain(projectKey(ref("env-a", "p1")));
  });

  it("keys by environment and project, not by bare project id", () => {
    const store = useGitManagerStore.getState();
    store.setActiveTab(ref("env-a", "p1"), "history");

    expect(store.selectViewState(ref("env-b", "p1")).activeTab).toBe("changes");
  });

  it("rehydrates only the two most recently used projects", async () => {
    const store = useGitManagerStore.getState();
    store.touchProject(ref("env-a", "p1"));
    store.touchProject(ref("env-a", "p2"));
    store.touchProject(ref("env-a", "p3"));
    store.setActiveTab(ref("env-a", "p2"), "history");
    const serialized = persisted.get(GIT_MANAGER_STORAGE_KEY);
    expect(serialized).toBeDefined();

    useGitManagerStore.setState({ byProjectKey: {} });
    persisted.set(GIT_MANAGER_STORAGE_KEY, serialized!);
    await useGitManagerStore.persist.rehydrate();

    expect(Object.keys(useGitManagerStore.getState().byProjectKey)).toHaveLength(2);
    expect(useGitManagerStore.getState().selectViewState(ref("env-a", "p1"))).toMatchObject({
      activeTab: "changes",
      lastUsedAt: 0,
    });
    expect(useGitManagerStore.getState().selectViewState(ref("env-a", "p2")).activeTab).toBe(
      "history",
    );
    expect(useGitManagerStore.getState().byProjectKey).toHaveProperty(
      projectKey(ref("env-a", "p3")),
    );
  });

  it("round-trips the commit draft through the versioned project key", async () => {
    const project = ref("env-a", "p1");
    useGitManagerStore.getState().setCommitDraft(project, "Keep this message");
    const serialized = persisted.get(GIT_MANAGER_STORAGE_KEY);
    const parsed = JSON.parse(serialized!) as {
      state: { byProjectKey: Record<string, { commitDraft: string }> };
    };
    expect(parsed.state.byProjectKey[projectKey(project)]?.commitDraft).toBe("Keep this message");

    useGitManagerStore.setState({ byProjectKey: {} });
    persisted.set(GIT_MANAGER_STORAGE_KEY, serialized!);
    await useGitManagerStore.persist.rehydrate();

    expect(useGitManagerStore.getState().selectViewState(project).commitDraft).toBe(
      "Keep this message",
    );
  });

  it("keeps checkout selection in memory while persisting the tab and commit draft", async () => {
    const project = ref("env-a", "p1");
    const store = useGitManagerStore.getState();
    store.setSelectedWorktree(project, "/opaque/feature");
    store.setActiveTab(project, "history");
    store.setCommitDraft(project, "Keep this draft");

    const serialized = persisted.get(GIT_MANAGER_STORAGE_KEY);
    const parsed = JSON.parse(serialized!) as {
      state: { byProjectKey: Record<string, Record<string, unknown>> };
    };
    const persistedViewState = parsed.state.byProjectKey[projectKey(project)];
    expect(persistedViewState).not.toHaveProperty("selectedWorktreeCwd");
    expect(persistedViewState).toMatchObject({
      activeTab: "history",
      commitDraft: "Keep this draft",
    });

    useGitManagerStore.setState({ byProjectKey: {} });
    persisted.set(GIT_MANAGER_STORAGE_KEY, serialized!);
    await useGitManagerStore.persist.rehydrate();

    expect(useGitManagerStore.getState().selectViewState(project)).toMatchObject({
      selectedWorktreeCwd: null,
      activeTab: "history",
      commitDraft: "Keep this draft",
    });
  });

  it("sanitizes current-version persisted state and reapplies the LRU bound", async () => {
    persisted.set(
      GIT_MANAGER_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        state: {
          byProjectKey: {
            invalid: { activeTab: "history", lastUsedAt: 100 },
            [projectKey(ref("env-a", "p1"))]: { activeTab: "invalid", lastUsedAt: 1 },
            [projectKey(ref("env-a", "p2"))]: { activeTab: "history", lastUsedAt: 2 },
            [projectKey(ref("env-a", "p3"))]: { activeTab: "history", lastUsedAt: 3 },
          },
        },
      }),
    );

    await useGitManagerStore.persist.rehydrate();

    const state = useGitManagerStore.getState();
    expect(Object.keys(state.byProjectKey)).toEqual([
      projectKey(ref("env-a", "p3")),
      projectKey(ref("env-a", "p2")),
    ]);
    expect(state.selectViewState(ref("env-a", "p1"))).toEqual(
      expect.objectContaining({ activeTab: "changes", lastUsedAt: 0 }),
    );
  });
});
