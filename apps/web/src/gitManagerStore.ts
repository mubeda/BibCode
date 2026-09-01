import { parseProjectKey, projectKey } from "@bibcode/client-runtime/state/entities";
import type { ScopedProjectRef } from "@bibcode/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const GIT_MANAGER_STORAGE_KEY = "bibcode:git-manager-state:v1";
const GIT_MANAGER_STORAGE_VERSION = 1;
const GIT_MANAGER_VIEW_STATE_LIMIT = 2;

export type GitManagerTab = "changes" | "history";

export interface GitManagerViewState {
  readonly selectedWorktreeCwd: string | null;
  readonly activeTab: GitManagerTab;
  readonly selectedRef: string | null;
  readonly selectedCommitSha: string | null;
  readonly selectedFilePath: string | null;
  readonly filterText: string;
  readonly loadedPageCount: number;
  readonly loadedPageCursors: ReadonlyArray<number>;
  readonly scrollAnchor: string | null;
  readonly commitDraft: string;
  readonly lastUsedAt: number;
}

type PersistedGitManagerViewState = Omit<GitManagerViewState, "selectedWorktreeCwd">;

interface PersistedGitManagerState {
  readonly byProjectKey: Record<string, PersistedGitManagerViewState>;
}

export const DEFAULT_GIT_MANAGER_VIEW_STATE: GitManagerViewState = Object.freeze({
  selectedWorktreeCwd: null,
  activeTab: "changes",
  selectedRef: null,
  selectedCommitSha: null,
  selectedFilePath: null,
  filterText: "",
  loadedPageCount: 0,
  loadedPageCursors: Object.freeze([]),
  scrollAnchor: null,
  commitDraft: "",
  lastUsedAt: 0,
});

interface GitManagerStoreState {
  readonly byProjectKey: Record<string, GitManagerViewState>;
  readonly selectViewState: (ref: ScopedProjectRef) => GitManagerViewState;
  readonly touchProject: (ref: ScopedProjectRef) => void;
  readonly setSelectedWorktree: (ref: ScopedProjectRef, cwd: string) => void;
  readonly setActiveTab: (ref: ScopedProjectRef, tab: GitManagerTab) => void;
  readonly setSelectedRef: (ref: ScopedProjectRef, name: string | null) => void;
  readonly setSelectedCommit: (ref: ScopedProjectRef, sha: string | null) => void;
  readonly setSelectedFile: (ref: ScopedProjectRef, path: string | null) => void;
  readonly setFilterText: (ref: ScopedProjectRef, text: string) => void;
  readonly setLoadedPageCount: (ref: ScopedProjectRef, count: number) => void;
  readonly setLoadedPageCursors: (ref: ScopedProjectRef, cursors: ReadonlyArray<number>) => void;
  readonly setScrollAnchor: (ref: ScopedProjectRef, anchor: string | null) => void;
  readonly setCommitDraft: (ref: ScopedProjectRef, draft: string) => void;
}

function nextLastUsedAt(byProjectKey: Record<string, GitManagerViewState>): number {
  let latest = 0;
  for (const viewState of Object.values(byProjectKey)) {
    latest = Math.max(latest, viewState.lastUsedAt);
  }
  return Math.max(Date.now(), latest + 1);
}

function retainMostRecent<T extends { readonly lastUsedAt: number }>(
  byProjectKey: Record<string, T>,
): Record<string, T> {
  const entries = Object.entries(byProjectKey);
  if (entries.length <= GIT_MANAGER_VIEW_STATE_LIMIT) return byProjectKey;

  entries.sort(
    ([leftKey, left], [rightKey, right]) =>
      right.lastUsedAt - left.lastUsedAt || leftKey.localeCompare(rightKey),
  );
  return Object.fromEntries(entries.slice(0, GIT_MANAGER_VIEW_STATE_LIMIT));
}

function updateProject(
  state: Pick<GitManagerStoreState, "byProjectKey">,
  ref: ScopedProjectRef,
  update: (current: GitManagerViewState) => GitManagerViewState,
): Pick<GitManagerStoreState, "byProjectKey"> {
  const key = projectKey(ref);
  const current = state.byProjectKey[key] ?? DEFAULT_GIT_MANAGER_VIEW_STATE;
  const updated = {
    ...update(current),
    lastUsedAt: nextLastUsedAt(state.byProjectKey),
  };
  return {
    byProjectKey: retainMostRecent({ ...state.byProjectKey, [key]: updated }),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function nonNegativeIntegerOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

function nonNegativeIntegerArray(value: unknown): ReadonlyArray<number> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (cursor): cursor is number =>
      typeof cursor === "number" && Number.isSafeInteger(cursor) && cursor >= 0,
  );
}

function sanitizeViewState(value: unknown): PersistedGitManagerViewState | null {
  if (value === null || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  return {
    activeTab: candidate.activeTab === "history" ? "history" : "changes",
    selectedRef: nullableString(candidate.selectedRef),
    selectedCommitSha: nullableString(candidate.selectedCommitSha),
    selectedFilePath: nullableString(candidate.selectedFilePath),
    filterText: stringOr(candidate.filterText, ""),
    loadedPageCount: nonNegativeIntegerOr(candidate.loadedPageCount, 0),
    loadedPageCursors: nonNegativeIntegerArray(candidate.loadedPageCursors),
    scrollAnchor: nullableString(candidate.scrollAnchor),
    commitDraft: stringOr(candidate.commitDraft, ""),
    lastUsedAt: nonNegativeIntegerOr(candidate.lastUsedAt, 0),
  };
}

export function sanitizePersistedGitManagerState(
  persistedState: unknown,
): PersistedGitManagerState {
  if (persistedState === null || typeof persistedState !== "object") {
    return { byProjectKey: {} };
  }
  const raw = (persistedState as { byProjectKey?: unknown }).byProjectKey;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { byProjectKey: {} };
  }

  const byProjectKey: Record<string, PersistedGitManagerViewState> = {};
  for (const [key, value] of Object.entries(raw)) {
    try {
      parseProjectKey(key);
    } catch {
      continue;
    }
    const viewState = sanitizeViewState(value);
    if (viewState !== null) byProjectKey[key] = viewState;
  }
  return { byProjectKey: retainMostRecent(byProjectKey) };
}

function restoreGitManagerState(
  persistedState: unknown,
): Pick<GitManagerStoreState, "byProjectKey"> {
  const persisted = sanitizePersistedGitManagerState(persistedState);
  return {
    byProjectKey: Object.fromEntries(
      Object.entries(persisted.byProjectKey).map(([key, viewState]) => [
        key,
        { ...viewState, selectedWorktreeCwd: null },
      ]),
    ),
  };
}

export const useGitManagerStore = create<GitManagerStoreState>()(
  persist(
    (set, get) => ({
      byProjectKey: {},
      selectViewState: (ref) =>
        get().byProjectKey[projectKey(ref)] ?? DEFAULT_GIT_MANAGER_VIEW_STATE,
      touchProject: (ref) => set((state) => updateProject(state, ref, (current) => current)),
      setSelectedWorktree: (ref, cwd) =>
        set((state) =>
          updateProject(state, ref, (current) => ({ ...current, selectedWorktreeCwd: cwd })),
        ),
      setActiveTab: (ref, tab) =>
        set((state) => updateProject(state, ref, (current) => ({ ...current, activeTab: tab }))),
      setSelectedRef: (ref, name) =>
        set((state) => updateProject(state, ref, (current) => ({ ...current, selectedRef: name }))),
      setSelectedCommit: (ref, sha) =>
        set((state) =>
          updateProject(state, ref, (current) => ({ ...current, selectedCommitSha: sha })),
        ),
      setSelectedFile: (ref, path) =>
        set((state) =>
          updateProject(state, ref, (current) => ({ ...current, selectedFilePath: path })),
        ),
      setFilterText: (ref, text) =>
        set((state) => updateProject(state, ref, (current) => ({ ...current, filterText: text }))),
      setLoadedPageCount: (ref, count) =>
        set((state) =>
          updateProject(state, ref, (current) => ({
            ...current,
            loadedPageCount: nonNegativeIntegerOr(count, current.loadedPageCount),
          })),
        ),
      setLoadedPageCursors: (ref, cursors) =>
        set((state) =>
          updateProject(state, ref, (current) => ({
            ...current,
            loadedPageCursors: nonNegativeIntegerArray(cursors),
          })),
        ),
      setScrollAnchor: (ref, anchor) =>
        set((state) =>
          updateProject(state, ref, (current) => ({ ...current, scrollAnchor: anchor })),
        ),
      setCommitDraft: (ref, draft) =>
        set((state) =>
          updateProject(state, ref, (current) => ({ ...current, commitDraft: draft })),
        ),
    }),
    {
      name: GIT_MANAGER_STORAGE_KEY,
      version: GIT_MANAGER_STORAGE_VERSION,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => sanitizePersistedGitManagerState(state),
      migrate: sanitizePersistedGitManagerState,
      merge: (persistedState, currentState) => ({
        ...currentState,
        ...restoreGitManagerState(persistedState),
      }),
    },
  ),
);
