import { parseProjectKey, projectKey } from "@bibcode/client-runtime/state/entities";
import type { PipelinesListScope, ScopedProjectRef } from "@bibcode/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "./lib/storage";

export const PIPELINES_STORAGE_KEY = "bibcode:pipelines-state:v1";

/** The list filters a route's search parameters carry; the store remembers the last ones. */
export interface PipelinesFilters {
  readonly scope: PipelinesListScope;
  readonly ref: string | null;
  /** GitHub only. */
  readonly workflowId: number | null;
}
export interface PipelinesViewState {
  readonly filters: PipelinesFilters;
  readonly scrollTop: number;
  readonly lastUsedAt: number;
}
export const DEFAULT_PIPELINES_FILTERS: PipelinesFilters = Object.freeze({
  scope: "all",
  ref: null,
  workflowId: null,
});
export const DEFAULT_PIPELINES_VIEW_STATE: PipelinesViewState = Object.freeze({
  filters: DEFAULT_PIPELINES_FILTERS,
  scrollTop: 0,
  lastUsedAt: 0,
});
interface PipelinesStoreState {
  readonly byProjectKey: Record<string, PipelinesViewState>;
  readonly selectViewState: (ref: ScopedProjectRef) => PipelinesViewState;
  readonly setFilters: (ref: ScopedProjectRef, filters: PipelinesFilters) => void;
  readonly setScrollTop: (ref: ScopedProjectRef, scrollTop: number) => void;
}
function retainMostRecent(byProjectKey: Record<string, PipelinesViewState>) {
  const entries = Object.entries(byProjectKey);
  if (entries.length <= 2) return byProjectKey;
  entries.sort(([a, x], [b, y]) => y.lastUsedAt - x.lastUsedAt || a.localeCompare(b));
  return Object.fromEntries(entries.slice(0, 2));
}
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
function nonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
/** Filters from untrusted input (storage or a route's search), with defaults for the rest. */
export function sanitizePipelinesFilters(value: unknown): PipelinesFilters {
  const f = record(value);
  return {
    scope: f.scope === "running" || f.scope === "finished" ? f.scope : "all",
    ref: typeof f.ref === "string" && f.ref.trim() !== "" ? f.ref.trim() : null,
    workflowId:
      typeof f.workflowId === "number" && Number.isSafeInteger(f.workflowId) && f.workflowId > 0
        ? f.workflowId
        : null,
  };
}
function sanitizePersistedState(value: unknown): Pick<PipelinesStoreState, "byProjectKey"> {
  const entries: [string, PipelinesViewState][] = [];
  for (const [key, raw] of Object.entries(record(record(value).byProjectKey))) {
    try {
      parseProjectKey(key);
    } catch {
      continue;
    }
    const v = record(raw);
    entries.push([
      key,
      {
        filters: sanitizePipelinesFilters(v.filters),
        scrollTop: nonNegative(v.scrollTop),
        lastUsedAt: nonNegative(v.lastUsedAt),
      },
    ]);
  }
  return { byProjectKey: retainMostRecent(Object.fromEntries(entries)) };
}
/**
 * Per-project Pipelines view state: the last list filters and scroll position, for
 * the two most recently used projects. The checkout is the Pull Requests store's,
 * shared by both modules through the repository module shell.
 */
export const usePipelinesStore = create<PipelinesStoreState>()(
  persist(
    (set, get) => {
      const update = (
        ref: ScopedProjectRef,
        fn: (current: PipelinesViewState) => PipelinesViewState,
      ) =>
        set((state) => {
          let latest = 0;
          for (const view of Object.values(state.byProjectKey))
            latest = Math.max(latest, view.lastUsedAt);
          const key = projectKey(ref);
          return {
            byProjectKey: retainMostRecent({
              ...state.byProjectKey,
              [key]: {
                ...fn(state.byProjectKey[key] ?? DEFAULT_PIPELINES_VIEW_STATE),
                lastUsedAt: Math.max(Date.now(), latest + 1),
              },
            }),
          };
        });
      return {
        byProjectKey: {},
        selectViewState: (ref) =>
          get().byProjectKey[projectKey(ref)] ?? DEFAULT_PIPELINES_VIEW_STATE,
        setFilters: (ref, filters) =>
          update(ref, (v) => ({ ...v, filters: sanitizePipelinesFilters(filters), scrollTop: 0 })),
        setScrollTop: (ref, scrollTop) =>
          update(ref, (v) => ({ ...v, scrollTop: nonNegative(scrollTop) })),
      };
    },
    {
      name: PIPELINES_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byProjectKey: state.byProjectKey }),
      migrate: sanitizePersistedState,
      merge: (persisted, current) => ({ ...current, ...sanitizePersistedState(persisted) }),
    },
  ),
);
