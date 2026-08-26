/**
 * Sidebar workspace-row metadata: pin state and unread markers.
 *
 * Orca-parity workspace rows (primary + worktree threads) carry small
 * app-level metadata that is not part of the server's thread model — pinning
 * for manual ordering and an unread marker cleared on visit. Keyed by
 * `scopedThreadKey` (environmentId+threadId), mirroring the pattern used by
 * `rightPanelStore.ts`.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { parseScopedThreadKey } from "@bibcode/client-runtime/environment";
import type { EnvironmentId } from "@bibcode/contracts";

import { resolveStorage } from "./lib/storage";

export const SIDEBAR_WORKSPACE_META_STORAGE_KEY = "bibcode:sidebar-workspace-meta:v1";
const SIDEBAR_WORKSPACE_META_STORAGE_VERSION = 2;

export interface SidebarWorkspaceMetaState {
  pinnedThreadKeys: string[];
  unreadThreadKeys: string[];
  togglePinned: (key: string) => void;
  markUnread: (key: string) => void;
  markRead: (key: string) => void;
  clearEnvironment: (environmentId: EnvironmentId) => void;
}

function withToggled(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((existing) => existing !== key) : [...keys, key];
}

function withAdded(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? [...keys] : [...keys, key];
}

function withRemoved(keys: readonly string[], key: string): string[] {
  return keys.includes(key) ? keys.filter((existing) => existing !== key) : [...keys];
}

export function migratePersistedSidebarWorkspaceMetaState(persistedState: unknown): {
  pinnedThreadKeys: string[];
  unreadThreadKeys: string[];
} {
  if (!persistedState || typeof persistedState !== "object") {
    return { pinnedThreadKeys: [], unreadThreadKeys: [] };
  }
  const state = persistedState as {
    pinnedThreadKeys?: unknown;
    unreadThreadKeys?: unknown;
  };
  const sanitizeKeys = (value: unknown): string[] =>
    Array.isArray(value)
      ? [
          ...new Set(
            value.filter(
              (key): key is string => typeof key === "string" && parseScopedThreadKey(key) !== null,
            ),
          ),
        ]
      : [];
  const pinnedThreadKeys = sanitizeKeys(state.pinnedThreadKeys);
  const unreadThreadKeys = sanitizeKeys(state.unreadThreadKeys);
  return { pinnedThreadKeys, unreadThreadKeys };
}

export function clearEnvironmentWorkspaceMeta(
  state: Pick<SidebarWorkspaceMetaState, "pinnedThreadKeys" | "unreadThreadKeys">,
  environmentId: EnvironmentId | string,
): Pick<SidebarWorkspaceMetaState, "pinnedThreadKeys" | "unreadThreadKeys"> {
  const keepOtherEnvironment = (key: string): boolean =>
    parseScopedThreadKey(key)?.environmentId !== environmentId;
  return {
    pinnedThreadKeys: state.pinnedThreadKeys.filter(keepOtherEnvironment),
    unreadThreadKeys: state.unreadThreadKeys.filter(keepOtherEnvironment),
  };
}

export const useSidebarWorkspaceMetaStore = create<SidebarWorkspaceMetaState>()(
  persist(
    (set) => ({
      pinnedThreadKeys: [],
      unreadThreadKeys: [],
      togglePinned: (key) =>
        set((state) => ({ pinnedThreadKeys: withToggled(state.pinnedThreadKeys, key) })),
      markUnread: (key) =>
        set((state) => ({ unreadThreadKeys: withAdded(state.unreadThreadKeys, key) })),
      markRead: (key) =>
        set((state) => ({ unreadThreadKeys: withRemoved(state.unreadThreadKeys, key) })),
      clearEnvironment: (environmentId) =>
        set((state) => clearEnvironmentWorkspaceMeta(state, environmentId)),
    }),
    {
      name: SIDEBAR_WORKSPACE_META_STORAGE_KEY,
      version: SIDEBAR_WORKSPACE_META_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        pinnedThreadKeys: state.pinnedThreadKeys,
        unreadThreadKeys: state.unreadThreadKeys,
      }),
      migrate: migratePersistedSidebarWorkspaceMetaState,
    },
  ),
);

export function selectIsPinned(pinnedThreadKeys: readonly string[], key: string): boolean {
  return pinnedThreadKeys.includes(key);
}

export function selectIsUnread(unreadThreadKeys: readonly string[], key: string): boolean {
  return unreadThreadKeys.includes(key);
}
