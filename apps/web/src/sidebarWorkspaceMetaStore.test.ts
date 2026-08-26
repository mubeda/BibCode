import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  clearEnvironmentWorkspaceMeta,
  migratePersistedSidebarWorkspaceMetaState,
  selectIsPinned,
  selectIsUnread,
  useSidebarWorkspaceMetaStore,
} from "./sidebarWorkspaceMetaStore";

beforeEach(() => {
  useSidebarWorkspaceMetaStore.setState({ pinnedThreadKeys: [], unreadThreadKeys: [] });
});

describe("sidebarWorkspaceMetaStore", () => {
  it("togglePinned adds then removes a key", () => {
    useSidebarWorkspaceMetaStore.getState().togglePinned("env-1:thread-A");
    expect(useSidebarWorkspaceMetaStore.getState().pinnedThreadKeys).toEqual(["env-1:thread-A"]);

    useSidebarWorkspaceMetaStore.getState().togglePinned("env-1:thread-A");
    expect(useSidebarWorkspaceMetaStore.getState().pinnedThreadKeys).toEqual([]);
  });

  it("togglePinned tracks multiple keys independently", () => {
    useSidebarWorkspaceMetaStore.getState().togglePinned("env-1:thread-A");
    useSidebarWorkspaceMetaStore.getState().togglePinned("env-1:thread-B");
    expect(useSidebarWorkspaceMetaStore.getState().pinnedThreadKeys).toEqual([
      "env-1:thread-A",
      "env-1:thread-B",
    ]);
  });

  it("markUnread is idempotent and markRead clears it", () => {
    useSidebarWorkspaceMetaStore.getState().markUnread("env-1:thread-A");
    useSidebarWorkspaceMetaStore.getState().markUnread("env-1:thread-A");
    expect(useSidebarWorkspaceMetaStore.getState().unreadThreadKeys).toEqual(["env-1:thread-A"]);

    useSidebarWorkspaceMetaStore.getState().markRead("env-1:thread-A");
    expect(useSidebarWorkspaceMetaStore.getState().unreadThreadKeys).toEqual([]);
  });

  it("markRead on an already-read key is a no-op", () => {
    useSidebarWorkspaceMetaStore.getState().markRead("env-1:thread-A");
    expect(useSidebarWorkspaceMetaStore.getState().unreadThreadKeys).toEqual([]);
  });

  it("selectIsPinned / selectIsUnread reflect key membership", () => {
    expect(selectIsPinned(["env-1:thread-A"], "env-1:thread-A")).toBe(true);
    expect(selectIsPinned(["env-1:thread-A"], "env-1:thread-B")).toBe(false);
    expect(selectIsUnread(["env-1:thread-A"], "env-1:thread-A")).toBe(true);
    expect(selectIsUnread([], "env-1:thread-A")).toBe(false);
  });

  describe("migratePersistedSidebarWorkspaceMetaState", () => {
    it("defaults to empty arrays for missing/invalid persisted state", () => {
      expect(migratePersistedSidebarWorkspaceMetaState(undefined)).toEqual({
        pinnedThreadKeys: [],
        unreadThreadKeys: [],
      });
      expect(migratePersistedSidebarWorkspaceMetaState(null)).toEqual({
        pinnedThreadKeys: [],
        unreadThreadKeys: [],
      });
      expect(migratePersistedSidebarWorkspaceMetaState({})).toEqual({
        pinnedThreadKeys: [],
        unreadThreadKeys: [],
      });
    });

    it("filters non-string entries out of persisted arrays", () => {
      expect(
        migratePersistedSidebarWorkspaceMetaState({
          pinnedThreadKeys: ["env-1:thread-A", 5, null],
          unreadThreadKeys: ["env-1:thread-B"],
        }),
      ).toEqual({
        pinnedThreadKeys: ["env-1:thread-A"],
        unreadThreadKeys: ["env-1:thread-B"],
      });
    });

    it("keeps only unique environment-scoped thread keys", () => {
      expect(
        migratePersistedSidebarWorkspaceMetaState({
          pinnedThreadKeys: ["env-1:thread-A", "env-1:thread-A", "unscoped", ""],
          unreadThreadKeys: ["env-2:thread-B", "env-2:thread-B", ":missing-environment"],
        }),
      ).toEqual({
        pinnedThreadKeys: ["env-1:thread-A"],
        unreadThreadKeys: ["env-2:thread-B"],
      });
    });
  });

  it("prunes only the forgotten environment's scoped metadata", () => {
    const next = clearEnvironmentWorkspaceMeta(
      {
        pinnedThreadKeys: ["env-1:thread-A", "env-2:thread-A"],
        unreadThreadKeys: ["env-1:thread-B", "env-2:thread-B"],
      },
      "env-1",
    );

    expect(next).toEqual({
      pinnedThreadKeys: ["env-2:thread-A"],
      unreadThreadKeys: ["env-2:thread-B"],
    });
  });

  it("sanitizes an existing v1 persistence envelope during real hydration", async () => {
    const originalStorage = useSidebarWorkspaceMetaStore.persist.getOptions().storage;
    const storage = {
      getItem: vi.fn(() => ({
        state: {
          pinnedThreadKeys: ["env-1:thread-A", "env-1:thread-A", "unscoped"],
          unreadThreadKeys: ["env-2:thread-B", ":invalid"],
        },
        version: 1,
      })),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    useSidebarWorkspaceMetaStore.persist.setOptions({ storage: storage as never });

    try {
      await useSidebarWorkspaceMetaStore.persist.rehydrate();
      expect(useSidebarWorkspaceMetaStore.getState()).toMatchObject({
        pinnedThreadKeys: ["env-1:thread-A"],
        unreadThreadKeys: ["env-2:thread-B"],
      });
    } finally {
      useSidebarWorkspaceMetaStore.persist.setOptions({ storage: originalStorage });
    }
  });
});
